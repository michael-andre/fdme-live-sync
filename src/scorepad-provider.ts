import * as net from "net";
import { Observable, map } from "rxjs";
import { MatchUpdate } from "./main";

export class ScorepadProvider {

  private readonly server = net.createServer();

  constructor() {
    this.server.listen(4001, "127.0.0.1", () => {
      console.log("Scorepad server started");
    });
  }

  observeUpdates(): Observable<Partial<MatchUpdate>> {
    return new Observable<Buffer>((sub) => {
      const listener = (socket: net.Socket) => {
        console.log("Scorepad client connected from " + socket.remoteAddress + ":" + socket.remotePort);
        socket.on("data", (data) => {
          sub.next(data);
        })
      };
      this.server.on("connection", listener);
      return () => this.server.off("connection", listener);
    }).pipe(
      map(buffer => {
        console.log(buffer.toJSON());
        return {};
      })
    )
  }

}