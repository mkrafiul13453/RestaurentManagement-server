import { Server } from "socket.io";
import { fromNodeHeaders } from "better-auth/node";

const staffRoles = new Set(["admin", "manager", "waiter", "cashier"]);
const supportedRoles = new Set([...staffRoles, "chef", "customer"]);

export function createRealtimeServer({ server, auth, clientOrigin }) {
  const io = new Server(server, {
    cors: {
      origin: clientOrigin,
      credentials: true,
      methods: ["GET", "POST"],
    },
    allowRequest(request, callback) {
      callback(null, request.headers.origin === clientOrigin);
    },
  });

  io.use(async (socket, next) => {
    try {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(socket.handshake.headers),
      });
      const user = session?.user;
      const role = typeof user?.role === "string" ? user.role.trim().toLowerCase() : "";
      if (!user || !supportedRoles.has(role)) {
        next(new Error("UNAUTHORIZED"));
        return;
      }

      socket.data.role = role;
      socket.data.userId = String(user.id);
      next();
    } catch {
      next(new Error("UNAUTHORIZED"));
    }
  });

  io.on("connection", (socket) => {
    const { role, userId } = socket.data;
    if (role === "chef") socket.join("kitchen");
    else if (role === "customer") socket.join(`orders:user:${userId}`);
    else if (staffRoles.has(role)) socket.join("orders:staff");
  });

  io.publishOrderUpdate = (order) => {
    if (!order?._id || !order?.status) return;
    const payload = {
      orderId: String(order._id),
      status: order.status,
      createdAt: order.createdAt ?? null,
      updatedAt: order.updatedAt ?? null,
      items: Array.isArray(order.lines)
        ? order.lines.map((line) => ({
          name: line.nameSnapshot,
          quantity: line.quantity,
        }))
        : [],
    };

    io.to("orders:staff").emit("order:updated", payload);
    if (order.userId) {
      io.to(`orders:user:${String(order.userId)}`).emit("order:updated", payload);
    }
    io.to("kitchen").emit("kitchen:order-updated", payload);
  };

  return io;
}
