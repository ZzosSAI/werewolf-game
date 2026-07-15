const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants ───────────────────────────────────────────────
const MIN_PLAYERS = 5;
const MAX_PLAYERS = 16;
const NIGHT_WAIT = 1500; // ms before first night action

// ─── Helpers ─────────────────────────────────────────────────
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

const ROLE_META = {
  werewolf: {
    name: 'Werewolf',
    emoji: '🐺',
    team: 'werewolf',
    description: 'Blend in by day. Hunt by night.',
    nightOrder: 2,
  },
  seer: {
    name: 'Seer',
    emoji: '🔮',
    team: 'village',
    description: 'Each night, peer into one soul.',
    nightOrder: 3,
  },
  witch: {
    name: 'Witch',
    emoji: '🧪',
    team: 'village',
    description: 'One save. One kill. Use wisely.',
    nightOrder: 4,
  },
  hunter: {
    name: 'Hunter',
    emoji: '🏹',
    team: 'village',
    description: 'Take someone with you when you fall.',
    nightOrder: -1,
  },
  guard: {
    name: 'Guard',
    emoji: '🛡️',
    team: 'village',
    description: 'Protect one player each night.',
    nightOrder: 1,
  },
  villager: {
    name: 'Villager',
    emoji: '🧑‍🌾',
    team: 'village',
    description: 'Use your voice and your vote.',
    nightOrder: -1,
  },
};

// ─── Game State Class ────────────────────────────────────────
class WerewolfGame {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.players = [];
    this.phase = 'lobby';
    this.round = 0;
    this.timer = null;
    this.timerRemaining = 0;
    this.votes = {};
    this.voted = new Set();

    // Night action state
    this.nightActionTargets = {};
    this.nightActionResult = {};
    this.killedByWerewolves = null;
    this.savedByWitch = false;
    this.guardTarget = null;

    // Witch state
    this.witchHasAntidote = true;
    this.witchHasPoison = true;

    // Hunter state
    this.hunterCanAct = false;
    this.hunterTarget = null;

    // History
    this.eliminated = [];
    this.lastNightDeaths = [];

    // Disconnect buffer
    this.disconnected = {};
  }

  // ─── Role Assignment ──────────────────────────────────
  assignRoles() {
    const count = this.players.length;
    let roles = [];

    // Always add werewolves (about 1/4 of players, min 1, max 3)
    const wolfCount = Math.min(4, Math.max(1, Math.floor(count / 4)));

    // Add special roles
    const specials = ['seer', 'witch', 'hunter', 'guard'];
    const numSpecials = Math.min(specials.length, count - wolfCount - 1);

    for (let i = 0; i < wolfCount; i++) roles.push('werewolf');
    for (let i = 0; i < numSpecials; i++) roles.push(specials[i]);

    // Fill rest with villagers
    while (roles.length < count) roles.push('villager');

    roles = shuffle(roles);
    const shuffledPlayers = shuffle(this.players);

    shuffledPlayers.forEach((p, i) => {
      const player = this.players.find(x => x.id === p.id);
      if (player) {
        player.role = roles[i];
        player.alive = true;
      }
    });
  }

  // ─── Queries ──────────────────────────────────────────
  getAlive() { return this.players.filter(p => p.alive); }
  getAliveByRole(role) { return this.players.filter(p => p.alive && p.role === role); }
  getAliveWerewolves() { return this.players.filter(p => p.alive && p.role === 'werewolf'); }
  getAliveVillagers() { return this.players.filter(p => p.alive && p.role !== 'werewolf'); }
  getPlayer(id) { return this.players.find(p => p.id === id); }

  isTeamAlive(team) {
    if (team === 'werewolf') return this.getAliveWerewolves().length > 0;
    return this.getAliveVillagers().length > 0;
  }

  checkWin() {
    const wolves = this.getAliveWerewolves();
    const villagers = this.getAliveVillagers();

    if (wolves.length === 0) return { over: true, winner: 'village' };
    if (wolves.length >= villagers.length) return { over: true, winner: 'werewolf' };
    return { over: false };
  }

  // ─── Timer ────────────────────────────────────────────
  startTimer(seconds, onExpire) {
    this.clearTimer();
    this.timerRemaining = seconds;
    this.timer = setInterval(() => {
      this.timerRemaining--;
      this.broadcast('timer', this.timerRemaining);
      if (this.timerRemaining <= 0) {
        this.clearTimer();
        if (onExpire) onExpire(this);
      }
    }, 1000);
  }

  clearTimer() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // ─── Broadcasting ─────────────────────────────────────
  broadcast(event, data) {
    io.to(this.roomCode).emit(event, data);
  }

  sendTo(playerId, event, data) {
    const s = this.getSocket(playerId);
    if (s) s.emit(event, data);
  }

  getSocket(playerId) {
    for (const [_, s] of io.sockets.sockets) {
      if (s.playerId === playerId) return s;
    }
    return null;
  }

  emitState() {
    const publicPlayers = this.players.map(p => ({
      id: p.id, name: p.name, avatar: p.avatar,
      alive: p.alive,
      role: p.role || null,
    }));

    this.broadcast('gameState', {
      phase: this.phase,
      round: this.round,
      players: publicPlayers,
      votes: this.votes,
      votedCount: this.voted.size,
      aliveCount: this.getAlive().length,
      totalPlayers: this.players.length,
      eliminated: this.eliminated,
      lastNightDeaths: this.lastNightDeaths,
      timerRemaining: this.timerRemaining,
    });
  }

  // ─── Game Flow ────────────────────────────────────────
  startGame() {
    this.assignRoles();
    this.round = 0;

    // Send role cards to each player
    this.players.forEach(p => {
      const meta = ROLE_META[p.role];
      this.sendTo(p.id, 'yourRole', {
        role: p.role,
        name: meta.name,
        emoji: meta.emoji,
        team: meta.team,
        description: meta.description,
      });
    });

    // Wait a moment for role reveals, then start night
    setTimeout(() => this.runNightCycle(), 3000);
  }

  runNightCycle() {
    this.phase = 'night';
    this.round++;
    this.lastNightDeaths = [];
    this.nightActionTargets = {};
    this.killedByWerewolves = null;
    this.savedByWitch = false;

    this.broadcast('nightPhase', {
      phase: 'start',
      round: this.round,
    });

    // Show "close your eyes" to everyone
    this.players.forEach(p => {
      if (!p.alive) return;
      this.sendTo(p.id, 'closeEyes', { round: this.round });
    });

    // Step 1: Guard
    setTimeout(() => this.guardTurn(), NIGHT_WAIT);
  }

  guardTurn() {
    const guard = this.getAliveByRole('guard')[0];
    if (!guard) {
      this.werewolfTurn();
      return;
    }
    this.currentPhase = 'guard_waiting';
    this.broadcast('whisper', { phase: 'guard' });
    this.sendTo(guard.id, 'guardAction', {
      alivePlayers: this.getAlive().filter(p => p.id !== guard.id).map(x => ({ id: x.id, name: x.name, avatar: x.avatar })),
      timeout: 8,
    });

    // Auto-skip after 8 seconds
    this.guardTimer = setTimeout(() => {
      this.sendTo(guard.id, 'nightActionResult', { success: true, message: '⏰ Time\'s up! No one protected.' });
      this.werewolfTurn();
    }, 8000);
  }

  submitGuard(playerId, targetId) {
    clearTimeout(this.guardTimer);
    this.guardTarget = targetId;
    const target = this.getPlayer(targetId);
    this.sendTo(playerId, 'nightActionResult', {
      success: true,
      message: `🛡️ You are protecting ${target?.name || 'them'} tonight!`,
    });
    this.werewolfTurn();
  }

  werewolfTurn() {
    const wolves = this.getAliveWerewolves();
    if (wolves.length === 0) {
      this.seerTurn();
      return;
    }
    this.currentPhase = 'werewolf_waiting';
    this.broadcast('whisper', { phase: 'werewolf' });

    wolves.forEach(w => {
      this.sendTo(w.id, 'werewolfAction', {
        alivePlayers: this.getAlive().filter(p => p.role !== 'werewolf' && p.alive).map(x => ({ id: x.id, name: x.name, avatar: x.avatar })),
        fellowWolves: wolves.filter(x => x.id !== w.id).map(x => ({ id: x.id, name: x.name, avatar: x.avatar })),
        timeout: 10,
      });
    });

    this.wolfVotes = {};
    this.wolfTimer = setTimeout(() => {
      if (!this.killedByWerewolves) {
        // Pick random target
        const targets = this.getAlive().filter(p => p.role !== 'werewolf');
        if (targets.length > 0) {
          this.killedByWerewolves = targets[Math.floor(Math.random() * targets.length)].id;
          this.broadcast('whisper', { phase: 'werewolf_result', killed: this.killedByWerewolves });
        }
      }
      this.seerTurn();
    }, 10000);
  }

  submitWolfVote(playerId, targetId) {
    if (!this.wolfVotes) this.wolfVotes = {};
    this.wolfVotes[playerId] = targetId;

    const wolves = this.getAliveWerewolves();
    const votes = Object.values(this.wolfVotes);
    const counts = {};
    votes.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
    const maxVotes = Math.max(...Object.values(counts), 0);
    const leaders = Object.keys(counts).filter(k => counts[k] === maxVotes);

    if (Object.keys(this.wolfVotes).length >= wolves.length) {
      clearTimeout(this.wolfTimer);
      this.killedByWerewolves = leaders.length === 1 ? leaders[0] : leaders[Math.floor(Math.random() * leaders.length)];
      this.broadcast('whisper', { phase: 'werewolf_result', killed: this.killedByWerewolves });
      this.seerTurn();
    }
  }

  seerTurn() {
    const seer = this.getAliveByRole('seer')[0];
    if (!seer) {
      this.witchTurn();
      return;
    }
    this.currentPhase = 'seer_waiting';
    this.broadcast('whisper', { phase: 'seer' });

    this.sendTo(seer.id, 'seerAction', {
      alivePlayers: this.getAlive().map(x => ({ id: x.id, name: x.name, avatar: x.avatar })),
      timeout: 8,
    });

    this.seerTimer = setTimeout(() => {
      this.sendTo(seer.id, 'nightActionResult', { success: true, message: '⏰ Time\'s up! You didn\'t check anyone.' });
      this.witchTurn();
    }, 8000);
  }

  submitSeerCheck(playerId, targetId) {
    clearTimeout(this.seerTimer);
    const target = this.getPlayer(targetId);
    if (!target) return;
    this.sendTo(playerId, 'nightActionResult', {
      success: true,
      checkResult: target.role,
      checkedPlayer: { id: target.id, name: target.name, avatar: target.avatar },
      message: `🔮 ${target.name} is a ${ROLE_META[target.role]?.emoji || '?'} ${ROLE_META[target.role]?.name || 'Unknown'}!`,
    });
    this.witchTurn();
  }

  witchTurn() {
    const witch = this.getAliveByRole('witch')[0];
    if (!witch) {
      this.resolveNight();
      return;
    }
    this.currentPhase = 'witch_waiting';
    this.broadcast('whisper', { phase: 'witch' });

    this.sendTo(witch.id, 'witchAction', {
      killedByWerewolves: this.killedByWerewolves,
      killedPlayer: this.killedByWerewolves ? this.getPlayer(this.killedByWerewolves) : null,
      hasAntidote: this.witchHasAntidote,
      hasPoison: this.witchHasPoison,
      alivePlayers: this.getAlive().filter(p => p.id !== witch.id).map(x => ({ id: x.id, name: x.name, avatar: x.avatar })),
      timeout: 10,
    });

    this.witchTimer = setTimeout(() => {
      this.resolveNight();
    }, 10000);
  }

  submitWitchAction(playerId, { action, targetId }) {
    clearTimeout(this.witchTimer);

    if (action === 'save' && this.witchHasAntidote && this.killedByWerewolves) {
      this.savedByWitch = true;
      this.witchHasAntidote = false;
      this.sendTo(playerId, 'nightActionResult', { success: true, message: '🧪 Antidote used! The victim is saved.' });
    } else if (action === 'poison' && targetId && this.witchHasPoison) {
      this.witchHasPoison = false;
      this.nightActionTargets.witchPoison = targetId;
      this.sendTo(playerId, 'nightActionResult', { success: true, message: `🧪 Poison used! ${this.getPlayer(targetId)?.name || 'They'} won't survive.` });
    } else {
      this.sendTo(playerId, 'nightActionResult', { success: true, message: '🧪 You did nothing this night.' });
    }

    this.resolveNight();
  }

  resolveNight() {
    // Determine who dies
    const deaths = [];

    // Check werewolf kill
    if (this.killedByWerewolves) {
      const target = this.getPlayer(this.killedByWerewolves);
      if (target && target.alive) {
        // Check if guarded
        if (this.guardTarget === this.killedByWerewolves) {
          // Protected by guard!
          this.broadcast('whisper', { phase: 'guard_success', protected: this.killedByWerewolves });
        } else if (this.savedByWitch) {
          // Saved by witch
        } else {
          // Dies
          target.alive = false;
          const meta = ROLE_META[target.role];
          deaths.push({ id: target.id, name: target.name, role: target.role, emoji: meta?.emoji || '💀', reason: 'killed_by_wolves' });
        }
      }
    }

    // Check witch poison
    if (this.nightActionTargets.witchPoison) {
      const poisoned = this.getPlayer(this.nightActionTargets.witchPoison);
      if (poisoned && poisoned.alive) {
        poisoned.alive = false;
        const meta = ROLE_META[poisoned.role];
        // Don't add duplicate
        if (!deaths.find(d => d.id === poisoned.id)) {
          deaths.push({ id: poisoned.id, name: poisoned.name, role: poisoned.role, emoji: meta?.emoji || '💀', reason: 'poisoned' });
        }
      }
    }

    this.lastNightDeaths = deaths;

    // Check if hunter needs to act
    const hunterDeath = deaths.find(d => d.role === 'hunter');
    if (hunterDeath && this.getAlive().length > 0) {
      // Hunter can shoot!
      const hunterSocket = this.getSocket(hunterDeath.id);
      if (hunterSocket) {
        this.phase = 'hunter_shot';
        this.broadcast('hunterDeath', {
          hunterId: hunterDeath.id,
          hunterName: hunterDeath.name,
        });
        this.sendTo(hunterDeath.id, 'hunterAction', {
          alivePlayers: this.getAlive().filter(p => p.id !== hunterDeath.id).map(x => ({ id: x.id, name: x.name, avatar: x.avatar })),
          timeout: 10,
        });

        this.hunterTimer = setTimeout(() => {
          this.afterHunter();
        }, 10000);
        this.emitState();
        return;
      }
    }

    this.afterHunter();
  }

  submitHunterShot(playerId, targetId) {
    clearTimeout(this.hunterTimer);
    const target = this.getPlayer(targetId);
    if (target && target.alive) {
      target.alive = false;
      const meta = ROLE_META[target.role];
      this.lastNightDeaths.push({
        id: target.id,
        name: target.name,
        role: target.role,
        emoji: meta?.emoji || '💀',
        reason: 'hunter_shot',
      });
    }
    this.afterHunter();
  }

  afterHunter() {
    const result = this.checkWin();
    if (result.over) {
      this.endGame(result.winner);
      return;
    }

    // Start day phase
    this.startDay();
  }

  startDay() {
    this.phase = 'day';
    this.votes = {};
    this.voted = new Set();

    const deaths = this.lastNightDeaths;
    this.broadcast('dayPhase', {
      round: this.round,
      deaths,
      aliveCount: this.getAlive().length,
    });

    this.emitState();

    // Start voting after a brief discussion delay
    setTimeout(() => this.startVoting(), 3000);
  }

  startVoting() {
    this.phase = 'voting';
    this.votes = {};
    this.voted = new Set();
    this.broadcast('startVoting', {
      alivePlayers: this.getAlive().map(x => ({ id: x.id, name: x.name, avatar: x.avatar })),
    });
    this.emitState();

    this.startTimer(30, () => this.resolveVotes());
  }

  submitVote(playerId, targetId) {
    if (this.phase !== 'voting') return;
    const player = this.getPlayer(playerId);
    if (!player || !player.alive) return;
    if (this.voted.has(playerId)) return;

    const target = this.getPlayer(targetId);
    if (!target || !target.alive) return;

    // Can't vote for self
    if (targetId === playerId) return;

    this.votes[playerId] = targetId;
    this.voted.add(playerId);
    this.emitState();

    // If everyone voted, resolve early
    if (this.voted.size >= this.getAlive().length) {
      this.clearTimer();
      this.resolveVotes();
    }
  }

  resolveVotes() {
    this.phase = 'vote_result';
    this.clearTimer();

    const count = {};
    Object.values(this.votes).forEach(id => { count[id] = (count[id] || 0) + 1; });

    let maxVotes = 0;
    let eliminatedId = null;
    let tie = false;

    for (const [id, c] of Object.entries(count)) {
      if (c > maxVotes) {
        maxVotes = c;
        eliminatedId = id;
        tie = false;
      } else if (c === maxVotes) {
        tie = true;
      }
    }

    // If tie (or no votes), no one is eliminated
    if (tie || maxVotes === 0) {
      eliminatedId = null;
    }

    if (eliminatedId) {
      const eliminated = this.getPlayer(eliminatedId);
      if (eliminated) {
        eliminated.alive = false;
        const meta = ROLE_META[eliminated.role];
        this.eliminated.push(eliminated.name);

        this.broadcast('voteResult', {
          eliminated: { id: eliminated.id, name: eliminated.name, role: eliminated.role, emoji: meta?.emoji || '💀' },
          voteCount: count,
          tie: false,
        });

        // Hunter check
        if (eliminated.role === 'hunter' && this.getAlive().length > 0) {
          this.phase = 'hunter_shot';
          this.broadcast('hunterDeath', {
            hunterId: eliminated.id,
            hunterName: eliminated.name,
          });
          this.sendTo(eliminated.id, 'hunterAction', {
            alivePlayers: this.getAlive().filter(p => p.id !== eliminated.id).map(x => ({ id: x.id, name: x.name, avatar: x.avatar })),
            timeout: 10,
          });
          this.hunterTimer = setTimeout(() => {
            this.afterDayVote();
          }, 10000);
          this.emitState();
          return;
        }
      }
    } else {
      this.broadcast('voteResult', {
        eliminated: null,
        voteCount: count,
        tie: true,
      });
    }

    this.afterDayVote();
  }

  afterDayVote() {
    const result = this.checkWin();
    if (result.over) {
      this.endGame(result.winner);
      return;
    }

    // Next night
    setTimeout(() => this.runNightCycle(), 2000);
  }

  endGame(winner) {
    this.phase = 'finished';
    this.clearTimer();
    this.broadcast('gameOver', {
      winner,
      players: this.players.map(p => ({
        id: p.id, name: p.name, avatar: p.avatar, role: p.role, alive: p.alive,
        emoji: ROLE_META[p.role]?.emoji || '?',
        team: ROLE_META[p.role]?.team || 'village',
      })),
    });
    this.emitState();
  }

  // ─── Player Management ────────────────────────────────
  addPlayer(socket, name, avatar) {
    const player = {
      id: socket.id,
      name: name || 'Player',
      avatar: avatar || '😊',
      role: null,
      alive: true,
    };
    this.players.push(player);
    socket.playerId = socket.id;
    socket.playerName = player.name;
    socket.playerAvatar = player.avatar;
    return player;
  }

  removePlayer(playerId) {
    const idx = this.players.findIndex(p => p.id === playerId);
    if (idx === -1) return null;
    const player = this.players[idx];
    this.players.splice(idx, 1);
    return player;
  }
}

// ─── Game Registry ────────────────────────────────────────────
const games = new Map();

// ─── Socket.io ────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('createRoom', (data, callback) => {
    const code = generateRoomCode();
    const game = new WerewolfGame(code);
    games.set(code, game);
    socket.join(code);
    currentRoom = code;

    game.addPlayer(socket, data.name, data.avatar);
    callback({ success: true, roomCode: code, playerId: socket.id });

    const ip = getLocalIP();
    const PORT = server.address().port;
    socket.emit('serverInfo', {
      localUrl: `http://localhost:${PORT}`,
      networkUrl: `http://${ip}:${PORT}`,
      port: PORT,
    });

    game.broadcast('playerJoined', {
      players: game.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar })),
    });
  });

  socket.on('joinRoom', (data, callback) => {
    const code = (data.roomCode || '').toUpperCase();
    const game = games.get(code);
    if (!game) return callback({ success: false, error: 'Room not found!' });
    if (game.phase !== 'lobby') return callback({ success: false, error: 'Game already started!' });
    if (game.players.length >= MAX_PLAYERS) return callback({ success: false, error: 'Room is full!' });

    socket.join(code);
    currentRoom = code;
    game.addPlayer(socket, data.name, data.avatar);
    callback({ success: true, roomCode: code, playerId: socket.id });

    game.broadcast('playerJoined', {
      players: game.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar })),
    });
  });

  socket.on('startGame', () => {
    if (!currentRoom) return;
    const game = games.get(currentRoom);
    if (!game || game.phase !== 'lobby') return;
    if (game.players.length < MIN_PLAYERS) {
      return io.to(currentRoom).emit('error', `Need ${MIN_PLAYERS}+ players to start!`);
    }
    game.startGame();
  });

  // ─── Night Actions ────────────────────────────────────
  socket.on('guardProtect', ({ targetId }) => {
    if (!currentRoom) return;
    const game = games.get(currentRoom);
    if (!game) return;
    game.submitGuard(socket.id, targetId);
  });

  socket.on('wolfKill', ({ targetId }) => {
    if (!currentRoom) return;
    const game = games.get(currentRoom);
    if (!game) return;
    game.submitWolfVote(socket.id, targetId);
  });

  socket.on('seerCheck', ({ targetId }) => {
    if (!currentRoom) return;
    const game = games.get(currentRoom);
    if (!game) return;
    game.submitSeerCheck(socket.id, targetId);
  });

  socket.on('witchAction', (data) => {
    if (!currentRoom) return;
    const game = games.get(currentRoom);
    if (!game) return;
    game.submitWitchAction(socket.id, data);
  });

  socket.on('hunterShot', ({ targetId }) => {
    if (!currentRoom) return;
    const game = games.get(currentRoom);
    if (!game) return;
    game.submitHunterShot(socket.id, targetId);
  });

  // ─── Day Voting ───────────────────────────────────────
  socket.on('vote', ({ targetId }) => {
    if (!currentRoom) return;
    const game = games.get(currentRoom);
    if (!game) return;
    game.submitVote(socket.id, targetId);
  });

  // ─── Disconnect ───────────────────────────────────────
  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const game = games.get(currentRoom);
    if (!game) return;

    const player = game.removePlayer(socket.id);
    if (!player) return;

    if (game.phase === 'lobby') {
      game.broadcast('playerLeft', {
        players: game.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar })),
      });
    } else if (game.phase !== 'finished') {
      // Check if game ends due to disconnect
      const result = game.checkWin();
      if (result.over) {
        game.endGame(result.winner);
      } else {
        game.broadcast('playerLeft', {
          playerId: socket.id,
          name: player.name,
          players: game.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar })),
        });
        game.emitState();
      }
    }

    if (game.players.length === 0) {
      games.delete(currentRoom);
    }
  });
});

// ─── Start Server ────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`🐺 Werewolf Game running!`);
  console.log(`   📍 Local:    http://localhost:${PORT}`);
  console.log(`   📍 Network:  http://${ip}:${PORT}`);
});
