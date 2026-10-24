import { DurableObject } from "cloudflare:workers";

const COLORS = ["red", "blue", "green", "yellow", "orange", "purple", "pink", "white"];
const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;
const JUDGE_ACTIONS = ["award", "reveal", "close", "dismiss", "reopen", "finish"];

function emptyRoom() {
  return {
    hostToken: "",
    teams: [],
    taken: {},
    names: {},
    armed: false,
    locked: false,
    winner: null,
    lockedAt: null,
    out: [],
    board: null
  };
}

function colorList(value) {
  const list = [];
  if (!Array.isArray(value)) {
    return list;
  }
  value.forEach(function (color) {
    if (COLORS.indexOf(color) !== -1 && list.indexOf(color) === -1) {
      list.push(color);
    }
  });
  return list;
}

function clip(value, max) {
  return String(value || "").slice(0, max);
}

function cleanName(value) {
  return String(value || "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 16);
}

function cleanNames(value) {
  const names = {};
  if (!value || typeof value !== "object") {
    return names;
  }
  COLORS.forEach(function (color) {
    const name = cleanName(value[color]);
    if (name) {
      names[color] = name;
    }
  });
  return names;
}

function cleanClue(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const amount = Math.floor(Number(value.amount));
  return {
    id: clip(value.id, 40),
    category: clip(value.category, 80),
    value: clip(value.value, 12),
    answer: clip(value.answer, 800),
    question: clip(value.question, 800),
    citation: clip(value.citation, 200),
    url: clip(value.url, 400),
    step: value.step === "question" ? "question" : "answer",
    amount: Number.isFinite(amount) ? Math.max(0, Math.min(100000, amount)) : 0
  };
}

function publicSource(board) {
  const clue = board && board.clue;
  if (!clue || clue.step !== "question") {
    return null;
  }
  const citation = clip(clue.citation, 200);
  const url = /^https?:\/\//i.test(clue.url || "") ? clip(clue.url, 400) : "";
  if (!citation && !url) {
    return null;
  }
  return { citation: citation, url: url };
}

function cleanScores(value) {
  const list = [];
  if (!Array.isArray(value)) {
    return list;
  }
  value.slice(0, 8).forEach(function (item) {
    if (!item || COLORS.indexOf(item.id) === -1 || list.some(function (row) {
      return row.id === item.id;
    })) {
      return;
    }
    const score = Math.floor(Number(item.score));
    list.push({
      id: item.id,
      score: Number.isFinite(score) ? Math.max(-1000000, Math.min(1000000, score)) : 0,
      name: cleanName(item.name)
    });
  });
  return list;
}

function cleanBoard(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return {
    clue: cleanClue(value.clue),
    scores: cleanScores(value.scores),
    round: clip(value.round, 40)
  };
}

export class BuzzRoom extends DurableObject {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const token = url.searchParams.get("token") || "";
    if (role !== "host" && role !== "player" && role !== "judge") {
      return new Response("Unknown role", { status: 400 });
    }
    const room = await this.load();
    if (role === "host") {
      if (token.length < 16 || token.length > 80) {
        return new Response("Bad host token", { status: 400 });
      }
      if (room.hostToken && room.hostToken !== token) {
        return new Response("Room code is in use", { status: 403 });
      }
      if (!room.hostToken) {
        room.hostToken = token;
        await this.save(room);
      }
    } else if (role === "judge") {
      if (!room.hostToken || token !== room.hostToken) {
        return new Response("Host rejected", { status: 403 });
      }
    } else if (!room.hostToken) {
      return new Response("Room is not open", { status: 404 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      id: crypto.randomUUID(),
      role: role,
      token: token,
      color: null
    });
    if (role === "judge") {
      this.broadcast(room);
    } else {
      server.send(JSON.stringify(this.view(room, null, role)));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") {
      return;
    }
    let data;
    try {
      data = JSON.parse(message);
    } catch (error) {
      return;
    }
    if (!data || typeof data.type !== "string") {
      return;
    }
    const attachment = ws.deserializeAttachment() || {};
    const room = await this.load();
    if (attachment.role === "host") {
      if (attachment.token !== room.hostToken) {
        ws.close(1008, "Host rejected");
        return;
      }
      if (!this.applyHost(room, data)) {
        return;
      }
      await this.save(room);
      this.broadcast(room);
      return;
    }
    if (attachment.role === "judge") {
      if (attachment.token !== room.hostToken) {
        ws.close(1008, "Host rejected");
        return;
      }
      if (data.type === "hold" || data.type === "release") {
        const holding = data.type === "hold";
        if (!!attachment.holding === holding) {
          return;
        }
        attachment.holding = holding;
        ws.serializeAttachment(attachment);
        this.broadcast(room);
        return;
      }
      this.forwardAction(data);
      return;
    }
    if (data.type === "claim") {
      if (!this.claimColor(room, ws, attachment, data.color, data.name)) {
        ws.send(JSON.stringify({ type: "error", message: "That color is taken." }));
        return;
      }
      await this.save(room);
      this.broadcast(room);
      return;
    }
    if (data.type === "buzz" && attachment.color && room.armed && !room.locked && !this.judgeHolding() && room.teams.indexOf(attachment.color) !== -1 && room.out.indexOf(attachment.color) === -1) {
      room.locked = true;
      room.winner = attachment.color;
      room.lockedAt = Date.now();
      await this.save(room);
      this.broadcast(room);
    }
  }

  async webSocketClose(ws) {
    const attachment = ws.deserializeAttachment() || {};
    if (attachment.role === "judge") {
      const room = await this.load();
      this.broadcast(room, attachment.id);
      return;
    }
    if (!attachment.color) {
      return;
    }
    const room = await this.load();
    if (room.taken[attachment.color] !== attachment.id) {
      return;
    }
    delete room.taken[attachment.color];
    await this.save(room);
    this.broadcast(room);
  }

  applyHost(room, data) {
    if (data.type === "teams" && Array.isArray(data.colors)) {
      const teams = [];
      data.colors.forEach(function (color) {
        if (COLORS.indexOf(color) !== -1 && teams.indexOf(color) === -1) {
          teams.push(color);
        }
      });
      room.teams = teams;
      room.out = room.out.filter(function (color) {
        return room.teams.indexOf(color) !== -1;
      });
      this.releaseMissing(room);
      if (room.winner && room.teams.indexOf(room.winner) === -1) {
        room.winner = null;
        room.locked = false;
        room.lockedAt = null;
      }
      return true;
    }
    if (data.type === "arm") {
      room.armed = true;
      if (data.fresh) {
        room.locked = false;
        room.winner = null;
        room.out = [];
        room.lockedAt = null;
      }
      return true;
    }
    if (data.type === "disarm") {
      room.armed = false;
      room.locked = false;
      room.winner = null;
      room.out = [];
      room.lockedAt = null;
      return true;
    }
    if (data.type === "miss") {
      if (COLORS.indexOf(data.color) === -1 || room.teams.indexOf(data.color) === -1) {
        return false;
      }
      if (room.out.indexOf(data.color) === -1) {
        room.out.push(data.color);
      }
      if (room.winner === data.color) {
        room.winner = null;
        room.locked = false;
        room.lockedAt = null;
      }
      return true;
    }
    if (data.type === "reset") {
      room.locked = false;
      room.winner = null;
      room.out = [];
      room.lockedAt = null;
      return true;
    }
    if (data.type === "board") {
      room.board = cleanBoard(data);
      return true;
    }
    return false;
  }

  forwardAction(data) {
    if (JUDGE_ACTIONS.indexOf(data.action) === -1) {
      return;
    }
    const action = {
      type: "action",
      id: crypto.randomUUID(),
      action: data.action
    };
    if (data.action === "award") {
      if (COLORS.indexOf(data.color) === -1) {
        return;
      }
      const delta = Math.floor(Number(data.delta));
      if (!delta || Math.abs(delta) > 100000) {
        return;
      }
      action.color = data.color;
      action.delta = delta;
    }
    const message = JSON.stringify(action);
    this.ctx.getWebSockets().forEach(function (ws) {
      const attachment = ws.deserializeAttachment() || {};
      if (attachment.role !== "host") {
        return;
      }
      try {
        ws.send(message);
      } catch (error) {
        // A closing host socket can reject the send.
      }
    });
  }

  claimColor(room, ws, attachment, color, name) {
    if (COLORS.indexOf(color) === -1 || room.teams.indexOf(color) === -1) {
      return false;
    }
    const owner = room.taken[color];
    if (owner && owner !== attachment.id) {
      const stillHere = this.ctx.getWebSockets().some(function (open) {
        const current = open.deserializeAttachment();
        return current && current.id === owner;
      });
      if (stillHere) {
        return false;
      }
    }
    if (attachment.color && attachment.color !== color && room.taken[attachment.color] === attachment.id) {
      delete room.taken[attachment.color];
    }
    room.taken[color] = attachment.id;
    attachment.color = color;
    ws.serializeAttachment(attachment);
    if (!room.names || typeof room.names !== "object") {
      room.names = {};
    }
    const clean = cleanName(name);
    if (clean) {
      room.names[color] = clean;
    } else {
      delete room.names[color];
    }
    return true;
  }

  releaseMissing(room) {
    const sockets = this.ctx.getWebSockets();
    Object.keys(room.taken).forEach(function (color) {
      if (room.teams.indexOf(color) !== -1) {
        return;
      }
      const owner = room.taken[color];
      delete room.taken[color];
      sockets.forEach(function (ws) {
        const attachment = ws.deserializeAttachment();
        if (!attachment || attachment.id !== owner) {
          return;
        }
        attachment.color = null;
        ws.serializeAttachment(attachment);
      });
    });
    Object.keys(room.names || {}).forEach(function (color) {
      if (room.teams.indexOf(color) === -1) {
        delete room.names[color];
      }
    });
  }

  broadcast(room, closingId) {
    this.ctx.getWebSockets().forEach((ws) => {
      const attachment = ws.deserializeAttachment() || {};
      if (closingId && attachment.id === closingId) {
        return;
      }
      try {
        ws.send(JSON.stringify(this.view(room, attachment.color || null, attachment.role || "player", closingId)));
      } catch (error) {
        // A closing socket can reject the send. The next snapshot covers the rest.
      }
    });
  }

  judgeOpen(closingId) {
    return this.ctx.getWebSockets().some(function (ws) {
      const attachment = ws.deserializeAttachment() || {};
      return attachment.role === "judge" && attachment.id !== closingId;
    });
  }

  judgeHolding(closingId) {
    return this.ctx.getWebSockets().some(function (ws) {
      const attachment = ws.deserializeAttachment() || {};
      return attachment.role === "judge" && attachment.holding && attachment.id !== closingId;
    });
  }

  view(room, you, role, closingId) {
    const payload = {
      type: "state",
      teams: room.teams,
      taken: Object.keys(room.taken),
      names: room.names || {},
      armed: !!room.armed,
      held: this.judgeHolding(closingId),
      locked: !!room.locked,
      winner: room.winner || null,
      lockedAt: room.lockedAt || null,
      now: Date.now(),
      out: room.out,
      you: you,
      source: publicSource(room.board)
    };
    if (role === "host" || role === "judge") {
      payload.board = room.board || null;
    }
    if (role === "host") {
      payload.judge = this.judgeOpen(closingId);
    }
    return payload;
  }

  async load() {
    const saved = await this.ctx.storage.get("room");
    if (!saved || typeof saved !== "object") {
      return emptyRoom();
    }
    return {
      hostToken: typeof saved.hostToken === "string" ? saved.hostToken : "",
      teams: Array.isArray(saved.teams) ? saved.teams : [],
      taken: saved.taken && typeof saved.taken === "object" ? saved.taken : {},
      names: cleanNames(saved.names),
      armed: !!saved.armed,
      locked: !!saved.locked,
      winner: typeof saved.winner === "string" ? saved.winner : null,
      lockedAt: Number.isFinite(saved.lockedAt) ? saved.lockedAt : null,
      out: colorList(saved.out),
      board: cleanBoard(saved.board)
    };
  }

  async save(room) {
    await this.ctx.storage.put("room", room);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/room") {
      return env.ASSETS.fetch(request);
    }
    const code = (url.searchParams.get("code") || "").toUpperCase();
    if (!CODE.test(code)) {
      return new Response("Bad room code", { status: 400 });
    }
    const id = env.BUZZ_ROOM.idFromName(code);
    return env.BUZZ_ROOM.get(id).fetch(request);
  }
};
