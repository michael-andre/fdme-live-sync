import * as net from "net";
import { Observable, distinctUntilChanged, filter, map, mergeMap, scan, share, tap } from "rxjs";
import { MatchUpdate } from "./main";
import { isEqual, merge } from "lodash";

export class ScorepadProvider {

  constructor(private isDev: boolean) {}

  observeUpdates(): Observable<Partial<MatchUpdate>> {
    return new Observable<net.Socket>(sub => {
      const server = net.createServer();
      server.listen(4001, "127.0.0.1", () => {
        console.log("Scorepad server started");
      });
      server.on("connection", (socket) => {
        console.log("Scorepad client connected from " + socket.remoteAddress + ":" + socket.remotePort);
        sub.next(socket);
      });
      return () => {
        server.close(() => console.debug("Scorepad server closed"));
        server.unref();
      };
    }).pipe(
      mergeMap(socket => new Observable<Buffer>(sub => {
        socket.on("data", (frame) => sub.next(frame));
        socket.on("close", () => sub.complete())
        return () => {
          socket.destroy();
          socket.unref();
        };  
      })),
      map(frame => {
        return this.processMessage(frame);
      }),
      filter((update): update is Partial<MatchUpdate> => update != null),
      scan((state, update) => merge(state, update), {} as Partial<MatchUpdate>),
      distinctUntilChanged(isEqual),
      tap(u => { if (this.isDev) console.debug(`Scorepad update: ${JSON.stringify(u)}`); }),
      share()
    )
  }

  // https://static.bodet-sport.com/images/stories/EN/support/Pdfs/manuals/Scorepad/608264-Network%20output%20and%20protocols-Scorepad.pdf
  private processMessage(frame: Buffer): Partial<MatchUpdate> | null {
    const msg = frame.subarray(4, -2);
    if (msg[0] == 0x30 && msg[1] == 0x31 && msg[3] == 0x34) {
      const clockStatus = msg[2];
      const isGameClock = ((clockStatus >>> 0) & 0x01) == 0;
      if (!isGameClock) return null;
      const chronoStarted = ((clockStatus >>> 1) & 0x01) == 1;
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