
import { ipcRenderer } from "electron";
import { MatchUpdate } from "./main";
import { Observable, exhaustMap } from "rxjs";

const host = new URLSearchParams(location.search).get("host");
const ws = new WebSocket(`ws://${host}:7000`);

const openedWs = new Promise<WebSocket>((resolve) => {
  ws.onopen = () => resolve(ws);
});

new Observable((sub) => {
  const listener = (_: unknown, data: MatchUpdate) => sub.next(data);
  ipcRenderer.on("match-update", listener);
  return () => ipcRenderer.off("match-update", listener);
}).pipe(
  exhaustMap(async update => {
    (await openedWs).send(JSON.stringify(update));
    console.debug("Local broadcast sent: " + JSON.stringify(update));
  })
).subscribe({
  error: (e) => {
    console.error("Local broadcast error");
    console.error(e);
  }
});
