import { entries, isEqual, merge } from "lodash";
import * as net from "net";
import * as os from "os";
import { BehaviorSubject, EMPTY, Observable, defer, distinctUntilChanged, map, mergeMap, repeat, retry, scan, share, switchMap, tap, timer } from "rxjs";
import { MatchUpdate, SourceState } from "./main";

export class ScorepadSource {

  private readonly scorepadServerPort = 4001;
  private readonly scanInterfacesDelayMs = 20000;
  private readonly serverRetryDelayMs = 10000;
  private readonly processingErrorRetryDelayMs = 5000;

  readonly state = new BehaviorSubject<SourceState>("off");

  readonly updates: Observable<MatchUpdate> = defer(() => this.findLocalEthernetInterfaceHost()).pipe(
    switchMap(host => {
      if (host) {
        return this.createTcpServer(host);
      } else {
        this.state.next("off");
        return EMPTY;
      }
    }),
    repeat({ delay: this.scanInterfacesDelayMs }),
    retry({
      delay: (e) => {
        console.error(`Scorepad server error: ${e}`);
        this.state.next("error");
        return timer(this.serverRetryDelayMs);
      }
    }),
    mergeMap(connection => {
      return this.observeDataFrame(connection).pipe(
        map(frame => this.processScorepadMessage(frame) ?? {} as MatchUpdate)
      )
    }),
    // Accumulate messages
    scan((state, update) => merge({}, state, update), {} as MatchUpdate),
    distinctUntilChanged<MatchUpdate>(isEqual),
    tap(u => {
      console.debug(`Scorepad update: ${JSON.stringify(u)}`);
    }),
    // Auto-retry on error
    retry({
      delay: (e) => {
        console.error(`Scorepad updates error: ${e}`);
        this.state.next("error");
        return timer(this.processingErrorRetryDelayMs);
      }
    }),
    share()
  );

  private async findLocalEthernetInterfaceHost(): Promise<string | null> {
    return entries(os.networkInterfaces())
      .find(([k]) => k.toLowerCase().startsWith("eth"))
      ?.[1]
      ?.find(i => i.family == "IPv4")
      ?.address
      ?? null;
  }

  private createTcpServer(host: string): Observable<net.Socket> {
    return new Observable<net.Socket>(sub => {
      const server = net.createServer();
      server.on("connection", (socket) => {
        this.state.next("connected");
        console.log(`Scorepad client connected from ${socket.remoteAddress}:${socket.remotePort}`);
        sub.next(socket);
      });
      server.on("error", e => {
        console.warn(`Scorepad server error: ${e}`);
        sub.error(e);
      });
      server.listen(this.scorepadServerPort, host, () => {
        this.state.next("ready");
        console.log(`Scorepad server started on ${host}:${this.scorepadServerPort}`);
      });
      return () => {
        try {
          server.close(() => console.debug("Scorepad server closed"));
          server.unref();
        } catch (e) {
          console.error(`Failed to close server: ${e}`);
        }
      };
    });
  }

  private observeDataFrame(connection: net.Socket): Observable<Buffer> {
    return new Observable<Buffer>(sub => {
      connection.on("data", (frame) => sub.next(frame));
      connection.on("close", () => sub.complete());
      connection.on("error", e => {
        console.warn(`Scorepad connection error: ${e}`);
        sub.error(e);
      });
      return () => {
        try {
          connection.destroy();
          connection.unref();
        } catch (e) {
          console.error(`Failed to close connection: ${e}`);
        }
      };
    });
  }

  /**
   * Parse a data frame to extract chrono and score information.
   * https://static.bodet-sport.com/images/stories/EN/support/Pdfs/manuals/Scorepad/608264-Network%20output%20and%20protocols-Scorepad.pdf
   * @param frame A raw frame for Scorepad connection
   * @returns Parsed MatchUpdate with chrono and score
   */
  private processScorepadMessage(frame: Buffer): MatchUpdate | null {
    // Omit frame prefix (SOH / Address / STX / CTRL) and suffix (ETX / LRC)
    const msg = frame.subarray(4, -2);
    if (msg[0] == 0x30 && msg[1] == 0x31 && msg[3] == 0x34) {
      // Handball / Message 01: game clock

      const clockStatus = msg[2];
      // Type of clock from bit 0 of clock status byte
      const isGameClock = ((clockStatus >>> 0) & 0x01) == 0;
      if (!isGameClock) return null;
      // Game clock status from bit 1 of clock status byte
      const chronoStarted = ((clockStatus >>> 1) & 0x01) == 0;

      // Chrono
      const min = Number(String.fromCharCode(msg[4])) * 10 + Number(String.fromCharCode(msg[5]));
      const sec = Number(String.fromCharCode(msg[6])) * 10 + Number(String.fromCharCode(msg[7]));
      const chrono = min * 60 + sec;
      const period = Number(String.fromCharCode(msg[10]));
      if (isNaN(chrono)) {
        console.warn("Invalid Scorepad frame for chrono");
        return null;
      }

      return { chrono, chronoStarted, period: isNaN(period) ? undefined : period };

    } else if (msg[0] == 0x30 && msg[1] == 0x32 && msg[2] == 0x34) {
      // Handball / Message 02: scores

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
        console.warn("Invalid Scorepad frame for score");
        return null;
      }

      return { homeScore, awayScore };

    }
    return null;
  }

}