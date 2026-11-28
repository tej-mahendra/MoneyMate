import { useEffect, useRef, useState } from "react";
import { EMPTY_LIST } from "../lib/stable";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useGoBack } from "../lib/useGoBack";
import { ensureOneOffCategory } from "../lib/oneOff";
import { db, type TxType, type SplitShare } from "../db/db";
import { todayISO, roundMoney, monthKey, monthLabel } from "../lib/format";
import { useUIStore } from "../store/useUIStore";
import Dropdown from "../components/Dropdown";
import { X, Users } from "lucide-react";

const RECENT_CAT_KEY = "pfos_last_category"; // suffixed per kind, e.g. `${RECENT_CAT_KEY}_expense`

/** What the person is logging. Savings/investments are stored as expense-type
 *  transactions in an allocation bracket (money moved, not spent) — "savings"
 *  is only a UI kind so they get their own tab instead of hiding in Expense.
 *  "oneoff" is the same idea for big irregular purchases (a phone, a bike):
 *  expense-type transactions in a one_off bracket, kept out of monthly spend. */
type Kind = "expense" | "income" | "savings" | "oneoff";
const isISODate = (v: string | null): v is string =>
  !!v && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v);

interface SplitPersonDraft {
  name: string;
  amount: string;
}

/** Splits `total` evenly across the given number of *other* people plus
 *  yourself, folding any rounding remainder into your own share so the
 *  numbers always sum to exactly `total` — never off by a paisa because
 *  of division. */
function evenSplit(
  total: number,
  otherCount: number,
): { yours: number; each: number } {
  const parties = otherCount + 1;
  if (parties <= 1 || total <= 0) return { yours: total, each: 0 };
  const each = Math.floor((total / parties) * 100) / 100;
  const yours = Math.round((total - each * otherCount) * 100) / 100;
  return { yours, each };
}

export default function AddTransaction() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const editId = searchParams.get("edit")
    ? Number(searchParams.get("edit"))
    : null;
  // After saving an edit, return to the detail page we came from.
  const goBackToDetail = useGoBack(`/transaction/${editId}`);
  const editingTx = useLiveQuery(
    () => (editId ? db.transactions.get(editId) : undefined),
    [editId],
  );
  const showToast = useUIStore((s) => s.showToast);
  const showConfirm = useUIStore((s) => s.showConfirm);
  const allCategories = useLiveQuery(() => db.categories.toArray(), []) ?? EMPTY_LIST;
  const allBrackets = useLiveQuery(() => db.brackets.toArray(), []) ?? EMPTY_LIST;
  const bracketKindById = new Map(allBrackets.map((b) => [b.id, b.kind]));
  const bracketById = new Map(allBrackets.map((b) => [b.id, b]));
  const hasOneOffBracket = allBrackets.some((b) => b.kind === "one_off" && !b.archived);

  // ?kind=oneoff&bracket=<id> lets a one-off bracket's own "Add a purchase"
  // button open this form already on the right tab and bracket.
  const [kind, setKind] = useState<Kind>(() =>
    searchParams.get("kind") === "oneoff" ? "oneoff" : "expense",
  );
  const type: TxType = kind === "income" ? "income" : "expense";
  // Each kind has its own category list — a "Food" cap makes no sense for a
  // salary deposit, and savings transfers aren't spending (see Settings →
  // Income sources / brackets for how these are managed).
  const kindOfCat = (c: { bracketId: number }): Kind | null => {
    const b = bracketById.get(c.bracketId);
    if (!b) return null; // orphaned category with no bracket at all
    if (b.kind === "income") return "income";
    if (b.kind === "allocation") return "savings";
    return b.kind === "one_off" ? "oneoff" : "expense";
  };
  // When editing, the entry's own category stays selectable even if its
  // bracket has since been archived — otherwise old entries can't be edited.
  const ownCategory = editingTx
    ? allCategories.find((c) => c.id === editingTx.categoryId)
    : undefined;
  // One-off purchases have no category step — just the bracket they go in
  // (asked only when there is more than one).
  const [oneOffBracketId, setOneOffBracketId] = useState<number | null>(() => {
    const p = Number(searchParams.get("bracket"));
    return p > 0 ? p : null;
  });
  const oneOffBrackets = allBrackets.filter(
    (b) => b.kind === "one_off" && (!b.archived || b.id === ownCategory?.bracketId),
  );
  const chosenOneOffBracket =
    oneOffBrackets.find((b) => b.id === oneOffBracketId) ?? oneOffBrackets[0];
  function categoriesFor(k: Kind) {
    const list = allCategories.filter((c) => {
      const bracket = bracketById.get(c.bracketId);
      return !!bracket && !bracket.archived && kindOfCat(c) === k;
    });
    if (ownCategory && !list.includes(ownCategory) && kindOfCat(ownCategory) === k) {
      list.push(ownCategory);
    }
    return list;
  }
  const categories = categoriesFor(kind);
  // Nothing to save into: no categories (or, for one-off, no bracket yet).
  const noTarget = kind === "oneoff" ? oneOffBrackets.length === 0 : categories.length === 0;

  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  // ?date=yyyy-mm-dd lets other screens start an entry in a past month.
  const [date, setDate] = useState(() => {
    const d = searchParams.get("date");
    return isISODate(d) ? d : todayISO();
  });
  const [merchant, setMerchant] = useState("");
  const [note, setNote] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("UPI");
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);

  // Splitting only applies to expenses — logging income never needs it.
  // `amount` above is the TOTAL you actually paid once split is on; your
  // own share is derived (total minus everyone else's), never typed
  // directly, so it can never silently drift out of sync with the people
  // list. Existing split shares (if editing a past split) are matched back
  // onto these draft rows by name when saving, so a partial repayment a
  // friend already made isn't lost just because you corrected an amount.
  const [splitEnabled, setSplitEnabled] = useState(false);
  const [splitPeople, setSplitPeople] = useState<SplitPersonDraft[]>([]);
  const existingShares = useLiveQuery(
    () =>
      editId
        ? db.splitShares.where("transactionId").equals(editId).toArray()
        : Promise.resolve<SplitShare[]>([]),
    [editId],
  );
  const knownNames = useLiveQuery(() => db.splitShares.toArray(), []);
  const nameSuggestions = [
    ...new Set(
      (knownNames ?? [])
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((s) => s.personName),
    ),
  ].slice(0, 8);

  // One-time prefill once the transaction being edited has loaded — after
  // that the fields are just normal controlled state the user can change.
  const prefilled = useRef(false);
  useEffect(() => {
    if (!editingTx || prefilled.current) return;
    // In edit mode, existingShares is a second, independent live query —
    // wait for it to actually resolve (even to an empty array) before
    // prefilling, since it could resolve after editingTx does. Locking in
    // prefilled.current before that would silently skip loading split data.
    if (editId && existingShares === undefined) return;
    prefilled.current = true;
    // Only income is decided here; whether an expense is really a savings
    // transfer is resolved from its category by the effect below (this
    // prefill can run after it, so it must not reset the tab to Expense).
    if (editingTx.type === "income") setKind("income");
    setCategoryId(editingTx.categoryId);
    setDate(editingTx.date);
    setMerchant(editingTx.merchant || "");
    setNote(editingTx.note || "");
    setPaymentMethod(editingTx.paymentMethod || "UPI");
    if (editingTx.merchant || editingTx.note) setAdvanced(true);

    if (existingShares && existingShares.length > 0) {
      // The transaction only ever stored your own share — reconstruct the
      // original total (what actually left your hand) for the form.
      const othersTotal = existingShares.reduce(
        (s, sh) => s + sh.amountOwed,
        0,
      );
      setAmount(String(editingTx.amount + othersTotal));
      setSplitEnabled(true);
      setSplitPeople(
        existingShares.map((sh) => ({
          name: sh.personName,
          amount: String(sh.amountOwed),
        })),
      );
    } else {
      setAmount(String(editingTx.amount));
    }
  }, [editingTx, existingShares, editId]);

  // An edited expense that was really a savings/investment transfer opens on
  // the Savings tab. Needs categories + brackets, which load independently.
  const kindResolved = useRef(false);
  useEffect(() => {
    if (!editingTx || kindResolved.current || editingTx.type === "income") return;
    if (!ownCategory || allBrackets.length === 0) return;
    kindResolved.current = true;
    const resolved = kindOfCat(ownCategory);
    if (resolved === "savings" || resolved === "oneoff") setKind(resolved);
    if (resolved === "oneoff") setOneOffBracketId(ownCategory.bracketId);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [editingTx, ownCategory, allBrackets.length]);

  function chooseKind(k: Kind) {
    setKind(k);
    if (editId) {
      // Edit mode skips the auto-pick below, so keep the category valid.
      const next = categoriesFor(k);
      if (!next.some((c) => c.id === categoryId)) setCategoryId(next[0]?.id ?? null);
    }
  }

  useEffect(() => {
    // In edit mode the category comes from the transaction being edited
    // (handled by the prefill effect above), not from "last used" —
    // otherwise this would stomp the loaded category the moment the type
    // resolves.
    if (editId) return;
    if (kind === "oneoff") return; // no category step for one-off purchases
    if (categories.length === 0) {
      setCategoryId(null);
      return;
    }
    const last = localStorage.getItem(`${RECENT_CAT_KEY}_${kind}`);
    const found = last && categories.find((c) => c.id === Number(last));
    setCategoryId(found ? found.id! : categories[0].id!);
    // Deliberately keyed on categories.length, not the array: re-running on
    // every category edit would reset the category the person just picked.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, categories.length, editId]);

  // Valid split rows: a real name and a positive amount. Rows with a blank
  // name or empty amount are just in-progress drafts, not real people yet.
  const validSplitPeople = splitPeople
    .map((p) => ({
      name: p.name.trim(),
      amount: roundMoney(parseFloat(p.amount) || 0),
    }))
    .filter((p) => p.name.length > 0 && p.amount > 0);
  const splitOthersTotal = roundMoney(
    validSplitPeople.reduce((s, p) => s + p.amount, 0),
  );
  const isSplitting =
    kind === "expense" && splitEnabled && validSplitPeople.length > 0;
  const yourShare = roundMoney(
    isSplitting
      ? (parseFloat(amount) || 0) - splitOthersTotal
      : parseFloat(amount) || 0,
  );

  const [splitManuallyEdited, setSplitManuallyEdited] = useState(false);

  function addSplitPerson() {
    setSplitPeople((prev) => {
      const next = [...prev, { name: "", amount: "" }];
      if (splitManuallyEdited) return next;
      // Auto-divide: rebalance EVERY row together, not just fill in an
      // amount for the newest one — otherwise adding a 3rd person would
      // leave the first two still showing their old 2-way-split amounts,
      // and the row totals would never actually sum to an even split.
      const total = parseFloat(amount) || 0;
      const { each } = evenSplit(total, next.length);
      return next.map((p) => ({ ...p, amount: each > 0 ? String(each) : "" }));
    });
  }
  function removeSplitPerson(i: number) {
    setSplitPeople((prev) => {
      const next = prev.filter((_, idx) => idx !== i);
      if (splitManuallyEdited || next.length === 0) return next;
      const total = parseFloat(amount) || 0;
      const { each } = evenSplit(total, next.length);
      return next.map((p) => ({ ...p, amount: each > 0 ? String(each) : "" }));
    });
  }
  function updateSplitPerson(
    i: number,
    field: keyof SplitPersonDraft,
    value: string,
  ) {
    if (field === "amount") setSplitManuallyEdited(true);
    setSplitPeople((prev) =>
      prev.map((p, idx) => (idx === i ? { ...p, [field]: value } : p)),
    );
  }

  async function reconcileSplitShares(transactionId: number) {
    const previous = editId ? (existingShares ?? []) : [];
    const previousByName = new Map(
      previous.map((s) => [s.personName.toLowerCase(), s]),
    );
    const keepNames = new Set(
      validSplitPeople.map((p) => p.name.toLowerCase()),
    );

    for (const old of previous) {
      if (!keepNames.has(old.personName.toLowerCase())) {
        await db.splitShares.delete(old.id!);
      }
    }
    for (const p of validSplitPeople) {
      const existing = previousByName.get(p.name.toLowerCase());
      if (existing) {
        // Preserve whatever's already been repaid — editing the split
        // shouldn't erase a friend's partial payment. If the corrected
        // amount is now less than what they've already paid, clamp the
        // settled figure down rather than leave it reading as "paid more
        // than they owed".
        await db.splitShares.update(existing.id!, {
          amountOwed: p.amount,
          amountSettled: Math.min(existing.amountSettled, p.amount),
        });
      } else {
        await db.splitShares.add({
          transactionId,
          personName: p.name,
          amountOwed: p.amount,
          amountSettled: 0,
          createdAt: Date.now(),
        });
      }
    }
  }

  async function save(addAnother: boolean) {
    const totalAmt = roundMoney(parseFloat(amount));
    if (!totalAmt || totalAmt <= 0) {
      showToast("Enter an amount greater than 0.");
      return;
    }
    // Nothing in the app is "scheduled": a future-dated entry would count in
    // this month's totals before it happened. Upcoming bills belong in
    // Settings → Recurring. (Re-saving an old future-dated entry unchanged is
    // still allowed, so it can't get stuck.)
    if (date > todayISO() && !(editingTx && editingTx.date === date)) {
      showToast("Future dates aren't allowed. Use a recurring entry for upcoming bills.");
      return;
    }
    const isOneOffEntry = kind === "oneoff";
    if (isOneOffEntry) {
      if (!merchant.trim()) {
        showToast("Enter what you bought.");
        return;
      }
      if (!chosenOneOffBracket) {
        showToast("Create a One-off bracket in Settings first.");
        return;
      }
    } else if (!categoryId) {
      showToast(
        type === "income"
          ? "Add an income source first."
          : "Pick a category first.",
      );
      return;
    }
    if (isSplitting && yourShare < 0) {
      showToast("The amounts you've split add up to more than the total.");
      return;
    }
    const amt = isSplitting ? yourShare : totalAmt;

    // Anything that touches a closed month changes a total people have
    // already reviewed — confirm it. This month's entries stay one-tap.
    const curMonth = monthKey(todayISO());
    const newMonth = monthKey(date);
    const oldMonth = editingTx ? monthKey(editingTx.date) : null;
    if (editId && (newMonth < curMonth || (oldMonth !== null && oldMonth < curMonth))) {
      const moved = oldMonth !== null && oldMonth !== newMonth;
      const ok = await showConfirm({
        title: "Save changes?",
        message: moved
          ? `This moves the entry from ${monthLabel(oldMonth!)} to ${monthLabel(newMonth)} and updates both months.`
          : `This updates ${monthLabel(newMonth)}'s totals.`,
        confirmLabel: "Save changes",
        cancelLabel: "Cancel",
      });
      if (!ok) return;
    } else if (!editId && newMonth < curMonth) {
      const ok = await showConfirm({
        title: `Add to ${monthLabel(newMonth)}?`,
        message: `This changes ${monthLabel(newMonth)}'s totals.`,
        confirmLabel: "Add entry",
        cancelLabel: "Cancel",
      });
      if (!ok) return;
    }
    setSaving(true);

    // One-off: the purchase lives in the bracket's own "Purchases" category.
    // Editing within the same bracket keeps whatever category it already had.
    let finalCategoryId = categoryId as number;
    if (isOneOffEntry) {
      try {
        finalCategoryId =
          editingTx && ownCategory && ownCategory.bracketId === chosenOneOffBracket!.id
            ? editingTx.categoryId
            : await ensureOneOffCategory(chosenOneOffBracket!.id!);
      } catch (err) {
        console.warn("Preparing one-off category failed", err);
        setSaving(false);
        showToast("Couldn't save that. Please try again.");
        return;
      }
    }

    if (editId) {
      try {
        await db.transaction("rw", db.transactions, db.splitShares, async () => {
          await db.transactions.update(editId, {
            type,
            amount: amt,
            categoryId: finalCategoryId,
            date,
            merchant: merchant.trim() || undefined,
            note: note.trim() || undefined,
            paymentMethod,
          });
          await reconcileSplitShares(editId);
        });
      } catch (err) {
        // Never leave the button stuck on "Saving…" or imply it worked.
        console.warn("Updating transaction failed", err);
        setSaving(false);
        showToast("Couldn't save your changes. Please try again.");
        return;
      }
      setSaving(false);
      showToast("Transaction updated.");
      goBackToDetail();
      return;
    }

    try {
      await db.transaction("rw", db.transactions, db.splitShares, async () => {
        const id = await db.transactions.add({
          type,
          amount: amt,
          categoryId: finalCategoryId,
          date,
          merchant: merchant.trim() || undefined,
          note: note.trim() || undefined,
          paymentMethod,
          createdAt: Date.now(),
        });
        if (isSplitting) await reconcileSplitShares(id);
      });
    } catch (err) {
      // Storage full / IndexedDB error: the transaction was rolled back, so
      // tell the person it was NOT saved and let them retry.
      console.warn("Saving transaction failed", err);
      setSaving(false);
      showToast("Couldn't save that. Please try again.");
      return;
    }
    // Remembering the last category is a convenience — a blocked
    // localStorage must not turn a successful save into an error.
    try {
      if (!isOneOffEntry) localStorage.setItem(`${RECENT_CAT_KEY}_${kind}`, String(categoryId));
    } catch {
      /* ignore */
    }
    setSaving(false);

    showToast(
      isOneOffEntry
        ? `Added ${merchant.trim()} to ${chosenOneOffBracket!.name}.`
        : isSplitting
        ? `Added ${amt} to ${categories.find((c) => c.id === categoryId)?.name || ""} — ${splitOthersTotal} split with ${validSplitPeople.length === 1 ? validSplitPeople[0].name : `${validSplitPeople.length} people`}.`
        : `Added ${amount} to ${categories.find((c) => c.id === categoryId)?.name || ""}.`,
    );
    if (addAnother) {
      setAmount("");
      setNote("");
      setMerchant("");
      setSplitEnabled(false);
      setSplitPeople([]);
    } else {
      // Spend-category transactions land on Budget (Rent/Food/etc.) for
      // immediate feedback on the category cap; allocation and income
      // transactions land on Home, since Budget never shows those at all.
      // Entries dated in a closed month land on that month's History so the
      // result is visible; otherwise the usual landing screens.
      if (monthKey(date) < curMonth) {
        navigate(`/history?month=${monthKey(date)}`, { replace: true });
        return;
      }
      const cat = categories.find((c) => c.id === categoryId);
      const bk = cat ? bracketKindById.get(cat.bracketId) : undefined;
      // replace: Back after saving shouldn't return to a finished Add form.
      // A one-off purchase lands on its bracket so the new item shows in the list.
      if (isOneOffEntry) {
        navigate(`/bracket/${chosenOneOffBracket!.id}`, { replace: true });
        return;
      }
      navigate(bk === "spend" ? "/budget" : "/", { replace: true });
    }
  }

  return (
    <>
      {editId ? (
        <header className="topbar">
          <div className="eyebrow">Editing</div>
          <h1>Edit transaction</h1>
          <div className="sub">Update the details below</div>
        </header>
      ) : (
        <header className="topbar">
          <div className="eyebrow">Log it</div>
          <h1>Add transaction</h1>
          <div className="sub">Takes about five seconds</div>
        </header>
      )}
      <div className="content">
        <div className="card">
          <div className="chip-row" style={{ marginBottom: 4 }}>
            {(
              [
                "expense",
                "income",
                "savings",
                // Only offered once a one-off bracket exists (or when
                // editing an entry that belongs to one).
                ...(hasOneOffBracket || kind === "oneoff" ? ["oneoff"] : []),
              ] as Kind[]
            ).map((k) => (
              <button
                key={k}
                className={"chip" + (kind === k ? " active" : "")}
                onClick={() => chooseKind(k)}
              >
                {k === "expense"
                  ? "Expense"
                  : k === "income"
                    ? "Income"
                    : k === "savings"
                      ? "Savings"
                      : "One-off"}
              </button>
            ))}
          </div>

          {kind === "oneoff" && (
            <>
              <label htmlFor="item">What did you buy?</label>
              <input
                id="item"
                type="text"
                placeholder="e.g. iPhone 16, Royal Enfield"
                value={merchant}
                onChange={(e) => setMerchant(e.target.value)}
              />
            </>
          )}

          <label htmlFor="amt">
            {isSplitting ? "Total you paid" : "Amount"}
          </label>
          <input
            id="amt"
            type="number"
            inputMode="decimal"
            placeholder="0.00"
            autoFocus
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onWheel={(e) => e.currentTarget.blur()}
          />

          {kind === "expense" && (
            <>
              <button
                type="button"
                className={"chip" + (splitEnabled ? " active" : "")}
                aria-pressed={splitEnabled}
                onClick={() => {
                  const turningOn = !splitEnabled;
                  setSplitEnabled(turningOn);
                  if (turningOn && splitPeople.length === 0) addSplitPerson();
                  if (!turningOn) {
                    setSplitPeople([]);
                    setSplitManuallyEdited(false);
                  }
                }}
                style={{
                  marginTop: 14,
                  marginBottom: splitEnabled ? 12 : 18,
                  padding: "10px 16px",
                }}
              >
                <Users size={14} />{" "}
                {splitEnabled ? "Splitting this expense" : "Split this expense"}
              </button>

              {splitEnabled && (
                <div
                  className="card"
                  style={{
                    background: "var(--surface-2, rgba(255,255,255,0.03))",
                    padding: 14,
                    marginBottom: 16,
                  }}
                >
                  <div
                    className="muted"
                    style={{ fontSize: 12, marginBottom: 8 }}
                  >
                    Who else was there? Don't add yourself — your own share is
                    worked out automatically below.
                  </div>
                  {splitPeople.map((p, i) => (
                    <div
                      key={i}
                      className="cat-edit-row"
                      style={{ padding: "6px 0" }}
                    >
                      <input
                        type="text"
                        placeholder="Name"
                        list="split-name-suggestions"
                        value={p.name}
                        onChange={(e) =>
                          updateSplitPerson(i, "name", e.target.value)
                        }
                      />
                      <input
                        type="number"
                        placeholder="Amount"
                        inputMode="decimal"
                        value={p.amount}
                        onChange={(e) =>
                          updateSplitPerson(i, "amount", e.target.value)
                        }
                        onWheel={(e) => e.currentTarget.blur()}
                      />
                      <button
                        className="icon-btn danger"
                        aria-label="Remove person"
                        onClick={() => removeSplitPerson(i)}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  ))}
                  <datalist id="split-name-suggestions">
                    {nameSuggestions.map((n) => (
                      <option key={n} value={n} />
                    ))}
                  </datalist>
                  <button
                    className="btn ghost"
                    style={{ marginTop: 8 }}
                    onClick={addSplitPerson}
                  >
                    + Add person
                  </button>
                  <div
                    className="muted"
                    style={{
                      marginTop: 10,
                      fontSize: 13,
                      color: yourShare < 0 ? "var(--over)" : undefined,
                    }}
                  >
                    Your share of this expense:{" "}
                    <b style={{ fontFamily: "var(--mono)" }}>
                      {Number.isFinite(yourShare)
                        ? yourShare.toFixed(2)
                        : "0.00"}
                    </b>
                    {yourShare < 0 && " — split amounts exceed the total"}
                  </div>
                </div>
              )}
            </>
          )}

          {kind === "oneoff" ? (
            oneOffBrackets.length === 0 ? (
              <div className="empty" style={{ padding: "20px 8px" }}>
                No one-off bracket yet.
                <div style={{ marginTop: 12 }}>
                  <button className="btn secondary" onClick={() => navigate("/settings")}>
                    Add one in Settings
                  </button>
                </div>
              </div>
            ) : oneOffBrackets.length > 1 ? (
              <>
                <label htmlFor="bracket">Bracket</label>
                <Dropdown
                  id="bracket"
                  value={String(chosenOneOffBracket?.id ?? "")}
                  onChange={(v) => setOneOffBracketId(Number(v))}
                  options={oneOffBrackets.map((b) => ({
                    value: String(b.id),
                    label: `${b.icon} ${b.name}`,
                  }))}
                />
              </>
            ) : null
          ) : categories.length === 0 ? (
            <div className="empty" style={{ padding: "20px 8px" }}>
              {type === "income"
                ? "No income sources set up yet."
                : "No categories set up yet."}
              <div style={{ marginTop: 12 }}>
                <button
                  className="btn secondary"
                  onClick={() => navigate("/settings")}
                >
                  Add one in Settings
                </button>
              </div>
            </div>
          ) : (
            <>
              <label htmlFor="cat">
                {kind === "income" ? "Source" : "Category"}
              </label>
              <Dropdown
                id="cat"
                value={categoryId != null ? String(categoryId) : ""}
                onChange={(v) => setCategoryId(Number(v))}
                options={categories.map((c) => {
                  const bracket = bracketById.get(c.bracketId);
                  const suffix =
                    bracket && bracket.kind !== "spend"
                      ? ` · ${bracket.name}`
                      : "";
                  return {
                    value: String(c.id),
                    label: `${c.icon} ${c.name}${suffix}`,
                  };
                })}
              />

              <div className="chip-row">
                {categories.slice(0, 5).map((c) => (
                  <button
                    key={c.id}
                    className={"chip" + (categoryId === c.id ? " active" : "")}
                    onClick={() => setCategoryId(c.id!)}
                  >
                    {c.icon} {c.name}
                  </button>
                ))}
              </div>
            </>
          )}

          <label htmlFor="date">Date</label>
          <input
            id="date"
            type="date"
            max={todayISO()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            // Desktop browsers open the calendar only from the tiny icon;
            // open it from a click anywhere on the field. Typing still works,
            // and browsers without showPicker() just keep their default.
            onClick={(e) => {
              try {
                e.currentTarget.showPicker?.();
              } catch {
                /* not allowed in this context — the native behaviour applies */
              }
            }}
          />

          {!advanced ? (
            <button className="btn ghost" onClick={() => setAdvanced(true)}>
              {kind === "oneoff" ? "+ Note, payment method" : "+ Merchant, note, payment method"}
            </button>
          ) : (
            <>
              {kind !== "oneoff" && (
                <>
                  <label htmlFor="merchant">Merchant</label>
                  <input
                    id="merchant"
                    type="text"
                    placeholder="e.g. Zomato"
                    value={merchant}
                    onChange={(e) => setMerchant(e.target.value)}
                  />
                </>
              )}
              <label htmlFor="note">Note</label>
              <input
                id="note"
                type="text"
                placeholder="Optional note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <label htmlFor="pm">Payment method</label>
              <Dropdown
                id="pm"
                value={paymentMethod}
                onChange={setPaymentMethod}
                options={[
                  "UPI",
                  "Cash",
                  "Credit Card",
                  "Debit Card",
                  "Wallet",
                  "Bank Transfer",
                ].map((p) => ({ value: p, label: p }))}
              />
            </>
          )}

          <button
            className="btn"
            disabled={saving || noTarget}
            onClick={() => save(false)}
          >
            {saving ? "Saving…" : editId ? "Save changes" : "Save"}
          </button>
          {!editId && (
            <button
              className="btn secondary"
              disabled={saving || noTarget}
              onClick={() => save(true)}
            >
              Save &amp; add another
            </button>
          )}
        </div>
      </div>
    </>
  );
}
