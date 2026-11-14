import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ConfirmDialog from '../components/ConfirmDialog';
import History from './History';
import { db } from '../db/db';
import { monthKey, todayISO, monthLabel, addMonths, fmtMoney } from '../lib/format';

beforeEach(async () => {
  await db.transactions.clear();
  await db.categories.clear();
  await db.brackets.clear();
  await db.settings.clear();
});

function renderHistory(initialPath = '/history') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/history" element={<History currency="₹" />} />
        <Route path="/transaction/:id" element={<div>Transaction detail screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function makeCategory(name: string) {
  const bracketId = await db.brackets.add({ name: 'Expenditure', icon: '💳', color: '#7C93F0', kind: 'spend' });
  return db.categories.add({ name, icon: '🏠', color: '#F0B94D', budget: 10000, bracketId });
}

describe('History — filtering', () => {
  it('only shows transactions in the currently-selected month', async () => {
    const catId = await makeCategory('Rent');
    const thisMonth = monthKey(todayISO());
    const [y, m] = thisMonth.split('-').map(Number);
    const prevMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;

    await db.transactions.add({ type: 'expense', amount: 5000, categoryId: catId, date: `${thisMonth}-10`, createdAt: Date.now(), merchant: 'This Month Rent' });
    await db.transactions.add({ type: 'expense', amount: 4000, categoryId: catId, date: `${prevMonth}-10`, createdAt: Date.now(), merchant: 'Last Month Rent' });

    renderHistory();

    expect(await screen.findByText(/This Month Rent/)).toBeInTheDocument();
    expect(screen.queryByText(/Last Month Rent/)).not.toBeInTheDocument();
  });

  it('filters by category when a ?cat= query param is present', async () => {
    const rentId = await makeCategory('Rent');
    const foodId = await makeCategory('Food');
    const thisMonth = monthKey(todayISO());
    await db.transactions.add({ type: 'expense', amount: 5000, categoryId: rentId, date: `${thisMonth}-10`, createdAt: Date.now() });
    await db.transactions.add({ type: 'expense', amount: 500, categoryId: foodId, date: `${thisMonth}-10`, createdAt: Date.now() });

    renderHistory(`/history?cat=${rentId}`);

    // "Rent" legitimately appears twice here — once as the active-filter
    // chip label, once as the transaction row's category name.
    expect((await screen.findAllByText('Rent')).length).toBeGreaterThan(0);
    // What matters is that the FILTERED TRANSACTION LIST excludes Food.
    const list = screen.getByTestId('transaction-list');
    expect(within(list).queryByText('Food')).not.toBeInTheDocument();
  });

  it('matches search against note, merchant, category name, and amount', async () => {
    const catId = await makeCategory('Groceries');
    const thisMonth = monthKey(todayISO());
    await db.transactions.add({ type: 'expense', amount: 1234, categoryId: catId, date: `${thisMonth}-05`, createdAt: Date.now(), merchant: 'BigBasket', note: 'Weekly veggies' });
    await db.transactions.add({ type: 'expense', amount: 700, categoryId: catId, date: `${thisMonth}-06`, createdAt: Date.now(), merchant: 'Corner Store' });

    const user = userEvent.setup();
    renderHistory();

    await screen.findByText('BigBasket', { exact: false });
    const search = screen.getByPlaceholderText('Search…');
    await user.type(search, 'veggies');

    expect(await screen.findByText(/BigBasket/)).toBeInTheDocument();
    expect(screen.queryByText(/Corner Store/)).not.toBeInTheDocument();
  });

  it('shows the empty state when nothing matches the current filters', async () => {
    renderHistory();
    expect(await screen.findByText('Nothing here yet.')).toBeInTheDocument();
  });

  it('shows "Uncategorized" for a transaction whose category no longer exists', async () => {
    // The documented behavior when a category is deleted outright rather
    // than archived — its transactions fall back to this rather than
    // crashing on a missing lookup.
    const thisMonth = monthKey(todayISO());
    await db.transactions.add({ type: 'expense', amount: 500, categoryId: 9999, date: `${thisMonth}-10`, createdAt: Date.now() });
    renderHistory();
    expect((await screen.findAllByText('Uncategorized')).length).toBeGreaterThan(0);
  });
});

describe('History — delete and undo', () => {
  it('removes a transaction from the list on delete, and restores it on Undo', async () => {
    const catId = await makeCategory('Rent');
    const thisMonth = monthKey(todayISO());
    await db.transactions.add({ type: 'expense', amount: 5000, categoryId: catId, date: `${thisMonth}-10`, createdAt: Date.now(), merchant: 'Landlord' });

    const user = userEvent.setup();
    renderHistory();

    await screen.findByText(/Landlord/);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText(/Landlord/)).not.toBeInTheDocument());
    expect(await db.transactions.count()).toBe(0);

    await user.click(await screen.findByText('Undo delete'));

    expect(await screen.findByText(/Landlord/)).toBeInTheDocument();
    expect(await db.transactions.count()).toBe(1);
  });

  it('deleting one row does not also remove other unrelated transactions', async () => {
    const catId = await makeCategory('Rent');
    const thisMonth = monthKey(todayISO());
    await db.transactions.add({ type: 'expense', amount: 5000, categoryId: catId, date: `${thisMonth}-10`, createdAt: Date.now(), merchant: 'Landlord' });
    await db.transactions.add({ type: 'expense', amount: 200, categoryId: catId, date: `${thisMonth}-11`, createdAt: Date.now(), merchant: 'Coffee' });

    const user = userEvent.setup();
    renderHistory();

    await screen.findByText(/Landlord/);
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    await user.click(deleteButtons[0]);

    expect(await db.transactions.count()).toBe(1);
  });
});

describe('History — navigation', () => {
  it('tapping a transaction row navigates to its detail page', async () => {
    const catId = await makeCategory('Rent');
    const thisMonth = monthKey(todayISO());
    await db.transactions.add({ type: 'expense', amount: 5000, categoryId: catId, date: `${thisMonth}-10`, createdAt: Date.now(), merchant: 'Landlord' });

    const user = userEvent.setup();
    renderHistory();

    await user.click(await screen.findByText(/Landlord/));
    expect(await screen.findByText('Transaction detail screen')).toBeInTheDocument();
  });
});

describe('History — budget review link', () => {
  it('links to the Budget screen\'s review of the month being viewed, only when that month has transactions', async () => {
    const rentId = await makeCategory('Rent');
    const thisMonth = monthKey(todayISO());
    await db.transactions.add({ type: 'expense', amount: 5000, categoryId: rentId, date: `${thisMonth}-10`, createdAt: Date.now() });
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/history']}>
        <Routes>
          <Route path="/history" element={<History currency="₹" />} />
          <Route path="/budget" element={<div>Budget screen</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await user.click(await screen.findByText(`${monthLabel(thisMonth)} budget review →`));
    expect(await screen.findByText('Budget screen')).toBeInTheDocument();
  });

  it('shows no review link or snapshot when the month has no transactions', async () => {
    renderHistory();
    await screen.findByText('Nothing here yet.');
    expect(screen.queryByText(/budget review/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('month-snapshot')).not.toBeInTheDocument();
  });

  it('opens on the month given in ?month= (deep link from the budget review)', async () => {
    const rentId = await makeCategory('Rent');
    const prev = '2026-03';
    await db.transactions.add({ type: 'expense', amount: 700, categoryId: rentId, date: `${prev}-10`, createdAt: Date.now(), merchant: 'March Landlord' });
    renderHistory(`/history?month=${prev}`);
    expect(await screen.findByText(/March Landlord/)).toBeInTheDocument();
  });
});


describe('History — whole-month snapshot, logged months, closed-month changes', () => {
  async function seedMixed(month: string) {
    const spend = await db.brackets.add({ name: 'Expenditure', icon: '💳', color: '#7C93F0', kind: 'spend' });
    const save = await db.brackets.add({ name: 'Savings', icon: '💰', color: '#4FD9B8', kind: 'allocation' });
    const inc = await db.brackets.add({ name: 'Income', icon: '💼', color: '#6FC98A', kind: 'income' });
    const food = await db.categories.add({ name: 'Food', icon: '🍲', color: '#F0B94D', budget: 0, bracketId: spend });
    const fund = await db.categories.add({ name: 'Fund', icon: '🛟', color: '#4FD9B8', budget: 0, bracketId: save });
    const salary = await db.categories.add({ name: 'Salary', icon: '💼', color: '#6FC98A', budget: 0, bracketId: inc });
    await db.transactions.add({ type: 'income', amount: 60000, categoryId: salary, date: `${month}-01`, createdAt: 1, merchant: 'Employer' });
    await db.transactions.add({ type: 'expense', amount: 15000, categoryId: food, date: `${month}-02`, createdAt: 2, merchant: 'Grocer' });
    await db.transactions.add({ type: 'expense', amount: 9000, categoryId: fund, date: `${month}-03`, createdAt: 3, merchant: 'Bank' });
    return { food, fund, salary };
  }

  it('the month snapshot shows income, spent, saved and left over — and ignores search filters', async () => {
    const cur = monthKey(todayISO());
    await seedMixed(cur);
    const user = userEvent.setup();
    renderHistory();
    const card = await screen.findByTestId('month-snapshot');
    expect(within(card).getAllByText(fmtMoney(60000, '₹')).length).toBeGreaterThan(0);
    expect(within(card).getAllByText(fmtMoney(15000, '₹')).length).toBeGreaterThan(0);
    expect(within(card).getAllByText(fmtMoney(9000, '₹')).length).toBeGreaterThan(0);
    expect(within(card).getByText(fmtMoney(36000, '₹'))).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Search…'), 'Grocer');
    expect(within(screen.getByTestId('month-snapshot')).getAllByText(fmtMoney(60000, '₹')).length).toBeGreaterThan(0);
  });

  it('the month dropdown lists only months with entries — nothing before logging began', async () => {
    const cur = monthKey(todayISO());
    await seedMixed(cur);
    renderHistory();
    await screen.findByTestId('month-snapshot');
    await userEvent.setup().click(screen.getByRole('button', { expanded: false, name: new RegExp(monthLabel(cur)) }));
    const options = within(await screen.findByRole('listbox')).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent(monthLabel(cur));
  });

  it('deleting from a closed month asks first; Keep it leaves the entry alone', async () => {
    const past = addMonths(monthKey(todayISO()), -2);
    await seedMixed(past);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={[`/history?month=${past}`]}>
        <Routes><Route path="/history" element={<History currency="₹" />} /></Routes>
        <ConfirmDialog />
      </MemoryRouter>,
    );
    await screen.findByText(/Grocer/);
    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(await db.transactions.count()).toBe(3);
    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(await db.transactions.count()).toBe(3);

    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(async () => expect(await db.transactions.count()).toBe(2));
  });

  it('a closed month offers "Add entry to <month>"', async () => {
    const past = addMonths(monthKey(todayISO()), -2);
    await seedMixed(past);
    renderHistory(`/history?month=${past}`);
    expect(await screen.findByRole('button', { name: new RegExp(`Add entry to ${monthLabel(past)}`) })).toBeInTheDocument();
  });
});


describe('History — snapshot blocks filter the list', () => {
  it('tapping Income / Saved / Spent shows only those entries; tapping again clears it', async () => {
    const cur = monthKey(todayISO());
    const spend = await db.brackets.add({ name: 'Expenditure', icon: '💳', color: '#7C93F0', kind: 'spend' });
    const save = await db.brackets.add({ name: 'Savings', icon: '💰', color: '#4FD9B8', kind: 'allocation' });
    const inc = await db.brackets.add({ name: 'Income', icon: '💼', color: '#6FC98A', kind: 'income' });
    const food = await db.categories.add({ name: 'Food', icon: '🍲', color: '#F0B94D', budget: 0, bracketId: spend });
    const fund = await db.categories.add({ name: 'Fund', icon: '🛟', color: '#4FD9B8', budget: 0, bracketId: save });
    const salary = await db.categories.add({ name: 'Salary', icon: '💼', color: '#6FC98A', budget: 0, bracketId: inc });
    await db.transactions.add({ type: 'income', amount: 60000, categoryId: salary, date: `${cur}-01`, createdAt: 1, merchant: 'Employer' });
    await db.transactions.add({ type: 'expense', amount: 15000, categoryId: food, date: `${cur}-02`, createdAt: 2, merchant: 'Grocer' });
    await db.transactions.add({ type: 'expense', amount: 9000, categoryId: fund, date: `${cur}-03`, createdAt: 3, merchant: 'Bank' });
    const user = userEvent.setup();
    renderHistory();
    const card = await screen.findByTestId('month-snapshot');

    await user.click(within(card).getByRole('button', { name: /^Saved & invested/ }));
    await waitFor(() => expect(screen.queryByText(/Grocer/)).not.toBeInTheDocument());
    expect(screen.getByText(/Bank/)).toBeInTheDocument();
    expect(screen.queryByText(/Employer/)).not.toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: /^Income/ }));
    expect(await screen.findByText(/Employer/)).toBeInTheDocument();
    expect(screen.queryByText(/Bank/)).not.toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: /^Spent/ }));
    expect(await screen.findByText(/Grocer/)).toBeInTheDocument();
    expect(screen.queryByText(/Bank/)).not.toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: /^Spent/ }));
    expect(await screen.findByText(/Bank/)).toBeInTheDocument();
    expect(screen.getByText(/Employer/)).toBeInTheDocument();
  });
});
