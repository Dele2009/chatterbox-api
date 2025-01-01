require('dotenv').config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const morgan = require("morgan");
const mongoose = require("mongoose");

const app = express();
const server = http.createServer(app);

// MongoDB connection
(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URL);
    console.log("Connected to MongoDB");
  }catch(err){
    console.log(err);
  }
})();
// Define Mongoose schemas
const userSchema = new mongoose.Schema({
  userId: String,
  socketID: { type: String, default: null },
  peerID: String,
  type: String,
  name: String,
});

const roomSchema = new mongoose.Schema({
  roomID: String,
  users: [userSchema],
});

const Room = mongoose.model("Room", roomSchema);

const origin = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://qqx4bjc0-5173.uks1.devtunnels.ms",
  "https://chatterbox-online.vercel.app",
]; // React app URLs

const io = new Server(server, {
  cors: {
    origin,
    methods: ["GET", "POST"],
  },
});

app.use(cors({ origin }));
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = 5500;

// Utility function to generate unique IDs
function generateId() {
  const chars = "abcdefghijklmnopqrstuvwxyz1234567890";
  return Array.from({ length: 9 })
    .map(() => chars.charAt(Math.floor(Math.random() * chars.length)))
    .join("");
}

// API Route: Create Room
app.get("/", (req, res) => res.send("app running"));

app.post("/create-room", async (req, res) => {
  const roomID = generateId();

  const existingRoom = await Room.findOne({ roomID });
  if (existingRoom) {
    return res.status(400).json({ error: "Room already exists" });
  }

  const hostUserId = generateId();
  const newRoom = new Room({
    roomID,
    users: [{ type: "host", userId: hostUserId, socketID: null }],
  });

  await newRoom.save();

  console.log(`Room created: ${roomID}`);
  return res.status(200).json({ roomID, role: "host", userId: hostUserId });
});

// Socket.io: Handle WebRTC and Room Logic
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-room", handleJoinRoom(socket));
  socket.on("mute-user", handleMuteUser);
  // Handle chat messages
  socket.on("chat-message", handleChat(socket));
  socket.on("disconnect", handleDisconnect(socket));
});

function handleChat(socket) {
  return async ({ sender, message, roomID, name }) => {
    const room = await Room.findOne({ roomID });
    if (room) {
      socket.to(roomID).emit("new-message", { sender, message, name });
    }
  };
}

function handleJoinRoom(socket) {
  return async ({ roomID, peerID, userId, name }, callback) => {
    const room = await Room.findOne({ roomID });
    if (!room) {
      console.log("Room does not exist");
      return callback({ error: "Room does not exist" });
    }

    const roomLength = room.users.length;
    name = (userId === "" && !name) ? `Guest ${roomLength}` : name;

    let role = "guest";
    if (userId !== "") {
      const user = room.users.find((u) => u.userId === userId);
      if (user) {
        user.socketID = socket.id;
        user.peerID = peerID;
        user.name = name;
        role = user.type;
        console.log(`User ${userId} reconnected as ${role}`);
      } else {
        return callback({ error: "Invalid userId" });
      }
    } else {
      userId = generateId();
      room.users.push({
        socketID: socket.id,
        peerID,
        userId,
        type: "guest",
        name,
      });
      console.log(`New guest joined room: ${roomID}`);
    }

    await room.save();

    socket.join(roomID);

    const existingUsers = room.users.filter(
      (user) => user.socketID !== socket.id
    );

    console.log(`Users in room ${roomID}:`, room.users);

    callback({ role, users: existingUsers });

    socket.to(roomID).emit("user-joined", { peerID, userId, name });
  };
}

function handleMuteUser({ roomID, targetUserId }) {
  Room.findOne({ roomID }).then((room) => {
    if (room) {
      const targetUser = room.users.find((user) => user.userId === targetUserId);
      if (targetUser) {
        io.to(targetUser.socketID).emit("muted");
        console.log(`User ${targetUserId} muted by the host`);
      }
    }
  });
}

function handleDisconnect(socket) {
  return async () => {
    console.log("User disconnected:", socket.id);

    const rooms = await Room.find();
    for (const room of rooms) {
      const disconnectedUser = room.users.find((user) => user.socketID === socket.id);
      if (disconnectedUser) {
        console.log(
          `Removing user ${disconnectedUser.userId} from room ${room.roomID}`
        );
        room.users = room.users.filter((user) => user.socketID !== socket.id);

        socket.to(room.roomID).emit("user-disconnected", {
          peerID: disconnectedUser.peerID,
        });

        if (room.users.length === 0) {
          await Room.deleteOne({ roomID: room.roomID });
          console.log(`Room ${room.roomID} deleted as it is empty`);
        } else {
          await room.save();
        }
        break;
      }
    }
  };
}

// Start the server
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
