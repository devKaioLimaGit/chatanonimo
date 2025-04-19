import { Session } from "express-session";

declare module "socket.io" {
  interface Handshake {
    session?: Session & { user?: { id: string; name: string; email: string } };
  }
}