import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { bytesToBase64 } from "./zip";

/** Binary twin of csv.ts's downloadFile(): same reasons for going through the
 *  native Filesystem + Share sheet on Android (the WebView guesses file names
 *  from MIME types for blob: URLs and gets them wrong). */
export async function downloadBinary(
  name: string,
  bytes: Uint8Array,
  type: string,
): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await Filesystem.writeFile({
      path: name,
      data: bytesToBase64(bytes), // no `encoding` → written as binary
      directory: Directory.Cache,
    });
    const { uri } = await Filesystem.getUri({ path: name, directory: Directory.Cache });
    await Share.share({ title: name, url: uri });
    return;
  }
  const blob = new Blob([bytes as BlobPart], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
