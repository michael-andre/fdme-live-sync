import * as fs from "fs";
import ReverseReader from "readline-reverse";
import { Observable, distinctUntilChanged, startWith, tap } from "rxjs";
import { exhaustMapLatest } from "./rx-utils";

const logFile = "C:\\Users\\Public\\Documents\\SaisieFeuilleGesthand\\LogFeuille.log";

export function observeActiveMatchCode(): Observable<string | null> {
  return observeFile(logFile).pipe(
    startWith(null),
    exhaustMapLatest(() => parseActiveMatchCode(logFile)),
    distinctUntilChanged(),
    tap(code => console.debug(`Match code: ${code}`))
  );
}

function observeFile(path: string): Observable<void> {
  return new Observable(sub => {
    const watcher = fs.watch(path, { encoding: "buffer" }, e => {
      if (e == "change") sub.next();
    });
    return () => watcher.close();
  })
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
  } catch (error) {
    console.warn("Failed to process log file", error);
  } finally {
    await reader.close();
  }
  return null;
}