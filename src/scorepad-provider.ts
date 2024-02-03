import * as net from "net";
import { Observable, distinctUntilChanged, filter, map, mergeMap, retry, scan, share, tap } from "rxjs";
import { MatchUpdate } from "./main";
import { isEqual, merge } from "lodash";

export class ScorepadProvider {

  constructor(private isDev: boolean) {}

  observeUpdates(): Observable<MatchUpdate> {
    return new Observable<net.Socket>(sub => {
      const server = net.createServer();
      server.listen(4001, "192.168.0.200", () => {
        console.log("Scorepad server started");
      });
      server.on("connection", (socket) => {
        console.log("Scorepad client connected from " + socket.remoteAddress + ":" + socket.remotePort);
        sub.next(socket);
      });
      server.on("error", e => {
        console.warn("Scorepad server error: " + e);
        sub.error(e);
      });
      return () => {
        try {
          server.close(() => console.debug("Scorepad server closed"));
          server.unref();  
        } catch (e) {
          console.error("Failed to close server: " + e);
        }
      };
    }).pipe(
      retry(),
      mergeMap(socket => new Observable<Buffer>(sub => {
        socket.on("data", (frame) => sub.next(frame));
        socket.on("close", () => sub.complete());
        socket.on("error",e => sub.error(e));
        return () => {
          try {
            socket.destroy();
            socket.unref();
          } catch (e) {
            console.error("Failed to close socket: " + e);
          }
        };
      })),
      retry(),
      map(frame => {
        return this.processMessage(frame);
      }),
      filter((update): update is MatchUpdate => update != null),
      scan((state, update) => merge({}, state, update), {} as MatchUpdate),
      distinctUntilChanged(isEqual),
      tap(u => { if (this.isDev) console.debug(`Scorepad update: ${JSON.stringify(u)}`); }),
      share()
    )
  }

  // https://static.bodet-sport.com/images/stories/EN/support/Pdfs/manuals/Scorepad/608264-Network%20output%20and%20protocols-Scorepad.pdf
  private processMessage(frame: Buffer): MatchUpdate | null {
    const msg = frame.subarray(4, -2);
    if (msg[0] == 0x30 && msg[1] == 0x31 && msg[3] == 0x34) {
      const clockStatus = msg[2];
      const isGameClock = ((clockStatus >>> 0) & 0x01) == 0;
      if (!isGameClock) return null;
      const chronoStarted = ((clockStatus >>> 1) & 0x01) == 0;
      const min = Number(String.fromCharCode(msg[4])) * 10 + Number(String.fromCharCode(msg[5]));
      const sec = Number(String.fromCharCode(msg[6])) * 10 + Number(String.fromCharCode(msg[7]));
      const chrono = min * 60 + sec;
      const period = Number(String.fromCharCode(msg[10]));
      if (isNaN(chrono)) {
        console.warn("Invalid chrono");
        return null;
      }
      return { chrono, chronoStarted, period: isNaN(period) ? undefined : period };
    } else if (msg[0] == 0x30 && msg[1] == 0x32 && msg[2] == 0x34) {
      const homeScore = Number((
        String.fromCharCode(msg[3])
        + String.fromCharCode(msg[4])
        + String.fromCharCode(msg[5])
      ).trim());
      const awayScore = Number((
        String.fromCharCode(msg[6])
        + String.fromCharCode(msg[7])
        + String.fromCharCode(msg[8])
      ).trim());
      if (isNaN(homeScore) || isNaN(awayScore)) {
        console.warn("Invalid score");
        return null;
      }
      return { homeScore, awayScore };
    }
    return null;
  }

}