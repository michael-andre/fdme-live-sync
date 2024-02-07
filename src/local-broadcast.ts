import { Observable, Subscription, tap } from "rxjs";
import { LiveUpdate } from "./data";
import { BrowserWindow, ipcMain } from "electron";
import * as path from "path";

export class LocalBroadcastConsumer {

  constructor(readonly host: string) {
    const sendWindow = new BrowserWindow({
      show: false, webPreferences: {
        offscreen: true,
        preload: path.join(__dirname, "local-broadcast-ws.js"),
        nodeIntegration: true
      }
    });
    sendWindow.loadFile("assets/window.html", { query: { host } });
    sendWindow.webContents.on("console-message", (_event, _level, message) => {
      console.debug(message);
    });
  }

  subscribe(updates: Observable<Partial<LiveUpdate>>): Subscription {
    return updates.pipe(
      tap((update) => {
        ipcMain.emit("match-update", update);
      })).subscribe({
        error: (e) => {
          console.error("Local boradcast error");
          console.error(e);
        }  
      });
  }

}