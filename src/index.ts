import express, { Request, Response } from "express";
import http from "http";
import { Server } from "socket.io";
import session from "express-session";
import sharedSession from "express-socket.io-session";
import prismaClient from "./prisma/prismaClient";
import { hash, compare } from "bcrypt";

const app = express();

const server = http
  .createServer(app)
  .listen(3000, () => console.log("Servidor rodando corretamente!"));
const io = new Server(server);

const sessionMiddleware = session({
    secret: "aa8af3ebe14831a7cd1b6d1383a03755",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 },
  });

app.use(sessionMiddleware);



app.use(express.json());

const ensureAuthenticated = (req: Request, res: Response, next: any) => {
  if (req.session.user) {
    return next(); // Usuário autenticado, prosseguir
  }
  res.redirect("/signin"); // Redirecionar para a página de login se não estiver autenticado
};

app.get("/", ensureAuthenticated, (req: Request, res: Response) => {
  res.sendFile(__dirname + "/index.html");
});

app.get("/signup", (req: Request, res: Response) => {
  res.sendFile(__dirname + "/signup.html");
});

app.post("/signup", async (req: Request, res: Response): Promise<any> => {
  try {
    const { name, email, password } = req.body;

    if (!email) {
      return res.status(400).json({ error: "O campo 'email' é obrigatório." });
    }

    const userAlreadyExist = await prismaClient.user.findFirst({
      where: { email },
    });

    if (userAlreadyExist) {
      return res
        .status(409)
        .json({ error: "Usuário já existe com esse email." });
    }

    const passwordHash = await hash(password, 10);

    const user = await prismaClient.user.create({
      data: {
        name,
        email,
        password: passwordHash,
      },
    });

    return res.status(200).json({ message: "Usuário registrado com sucesso!" });
  } catch (error) {
    return res.status(500).json({ message: "Falha ao registra usuário!" });
  }
});

app.get("/signin", async (req: Request, res: Response) => {
  res.sendFile(__dirname + "/signin.html");
});

app.post("/authenticate", async (req: Request, res: Response): Promise<any> => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email e senha são obrigatórios." });
  }

  const user = await prismaClient.user.findFirst({ where: { email } });

  if (!user) {
    return res.status(400).json({ error: "Email ou senha incorretos." });
  }

  const passwordMatch = await compare(password, user.password);

  if (!passwordMatch) {
    return res.status(400).json({ error: "Email ou senha incorretos." });
  }

  // Armazenando dados na sessão
  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
  };

  console.log(req.session.user)

  return res.status(200).json({ message: "Autenticado com sucesso!" });
});


// No back-end
app.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.log(err);
      res.sendStatus(500);
    } else {
      res.clearCookie("connect.sid", { path: "/" });
      res.sendStatus(200); // responde com sucesso
    }
  });
});


io.use(sharedSession(sessionMiddleware, {
  autoSave: true,
}));

io.on("connection", async (socket) => {
  const user = (socket.handshake as any).session?.user;

  if (!user) {
    socket.disconnect();
    return;
  }

  console.log(`Usuário ${user.name} conectado com socket ID: ${socket.id}`);

  // Criar uma sala automaticamente com o socket.id do usuário
  const roomId = socket.id; // Usar socket.id como ID da sala
  socket.join(roomId); // Associar o usuário à sua própria sala
  socket.emit("joinedRoom", {
    roomId,
    message: `Você criou a sala ${roomId}.`,
    socketId: socket.id,
  });

  // Enviar o socket.id para o cliente
  socket.emit("sessionInfo", { socketId: socket.id });

  // Função para entrar em uma sala
  socket.on("joinRoom", async (roomId: string) => {
    try {
      // Impedir que o usuário entre na própria sala (já está nela)
      if (roomId === socket.id) {
        socket.emit("error", { message: "Você já está na sua própria sala." });
        return;
      }

      // Verificar quantos usuários estão na sala
      const clientsInRoom = await io.in(roomId).allSockets();
      const clientCount = clientsInRoom.size;

      if (clientCount >= 2) {
        socket.emit("roomFull", { message: "A sala está cheia (máximo 2 usuários)." });
        return;
      }

      // Entrar na sala
      socket.join(roomId);
      socket.emit("joinedRoom", {
        roomId,
        message: `Você entrou na sala ${roomId}.`,
        socketId: socket.id,
      });

      // Notificar outros na sala
      socket.to(roomId).emit("userJoined", {
        user: user.name,
        message: `${user.name} entrou na sala.`,
      });

      // Atualizar número de usuários
      io.to(roomId).emit("roomStatus", { userCount: clientCount + 1 });
    } catch (error) {
      socket.emit("error", { message: "Erro ao entrar na sala." });
    }
  });

  // Receber e enviar mensagens
  socket.on("sendMessage", ({ roomId, message }: { roomId: string; message: string }) => {
    if (!message.trim()) return;

    // Verificar se o usuário está na sala
    if (!socket.rooms.has(roomId)) {
      socket.emit("error", { message: "Você não está nesta sala." });
      return;
    }

    // Enviar mensagem para todos na sala
    io.to(roomId).emit("receiveMessage", {
      user: user.name,
      message,
      timestamp: new Date().toISOString(),
      socketId: socket.id,
    });
  });

  // Lidar com desconexão
  socket.on("disconnect", async () => {
    console.log(`Usuário ${user.name} desconectado.`);

    const rooms = Array.from(socket.rooms).filter((room) => room !== socket.id);
    for (const roomId of rooms) {
      socket.to(roomId).emit("userLeft", {
        user: user.name,
        message: `${user.name} saiu da sala.`,
      });

      const clientsInRoom = await io.in(roomId).allSockets();
      io.to(roomId).emit("roomStatus", { userCount: clientsInRoom.size });
    }
  });
});