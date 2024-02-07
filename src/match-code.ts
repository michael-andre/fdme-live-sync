import * as fs from "fs";
import * as os from "os";
import ReverseReader from "readline-reverse";
import { NEVER, Observable, distinctUntilChanged, of, retry, shareReplay, startWith, tap, timer } from "rxjs";
import { exhaustMapLatest } from "./rx-utils";

const errorRetryDelayMs = 5000;

export function observeActiveMatchCode(testMode: boolean): Observable<string | null> {
  if (testMode) {
    return of("FTESTxx");
  }
  const publicDir = os.platform() == "win32" ? process.env["CSIDL_COMMON_DESKTOPDIRECTORY"] : null;
  if (!publicDir) {
    console.warn("Not running Windows, match code detection disabled");
    return NEVER;
  }
  const logFilePath = `${publicDir}\\SaisieFeuilleGesthand\\LogFeuille.log`;
  if (!fs.existsSync(logFilePath)) {
    throw Error("FDME log file not found");
  }
  return observeLogFileChanges(logFilePath).pipe(
    exhaustMapLatest(() => parseActiveMatchCode(logFilePath)),
    distinctUntilChanged(),
    tap(code => console.debug(`Match code: ${code}`)),
    // Auto-retry on error
    retry({ delay: (e) => {
      console.error(`Log file watch error: ${e}`);
      return timer(errorRetryDelayMs);
    }}),
    shareReplay({ refCount: true, bufferSize: 1 })
  );
}

function observeLogFileChanges(path: string): Observable<void> {
  return new Observable<void>(sub => {
    const watcher = fs.watch(path, { encoding: "buffer" }, e => {
      if (e == "change") sub.next();
    });
    return () => watcher.close();
  }).pipe(
    startWith(undefined)
  );
}

async function parseActiveMatchCode(logFile: string): Promise<string | null> {
  const reader = new ReverseReader();
  try {
    await reader.open(logFile);
    const lines = await reader.read(10);
    const pattern = new RegExp("ouverture feuille table coderenc=([A-Z]{7})");
    for (const line of lines.reverse()) {
      const match = line.match(pattern);
      if (match) return match[1];
    }
  } catch (e) {
    console.warn(`Failed to process log file: ${e}`);
  } finally {
    await reader.close();
  }
  return null;
}