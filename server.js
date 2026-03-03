const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const fs      = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());

// ─── Static files ─────────────────────────────────────────────────────────────
const publicDir    = path.join(__dirname, 'public');
const hasPublicDir = fs.existsSync(publicDir) && fs.existsSync(path.join(publicDir, 'index.html'));
const staticDir    = hasPublicDir ? publicDir : __dirname;
app.use(express.static(staticDir));
app.get('/', (req, res) => res.sendFile(path.join(staticDir, 'index.html')));

// ─── Load config.json ─────────────────────────────────────────────────────────
const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) { console.error('config.json not found'); process.exit(1); }
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const INITIAL_BUDGET = config.game.initialBudget;
const MIN_PLAYERS    = config.game.minPlayersPerTeam;
const MIN_PRICE      = config.game.minPlayerPrice;
const BID_TIMER      = config.game.bidTimerSeconds;
const PASSWORDS      = config.passwords;
const TEAM_DEFS      = config.teams;

console.log(`Config loaded — budget $${INITIAL_BUDGET}, timer ${BID_TIMER}s`);

// ─── Load players.json ────────────────────────────────────────────────────────
// Root players.json = master roster (you edit this, app never writes to it)
const playersPath = path.join(__dirname, 'players.json');
if (!fs.existsSync(playersPath)) { console.error('players.json not found'); process.exit(1); }
const RAW_PLAYERS = JSON.parse(fs.readFileSync(playersPath, 'utf8'));
console.log(`Players loaded — ${RAW_PLAYERS.length} players`);

// data/player_statuses.json = runtime auction statuses (written by app, never edit manually)
const playerStatusesPath = path.join(__dirname, 'data', 'player_statuses.json');

// ─── State factory ────────────────────────────────────────────────────────────
function createInitialState() {
  return {
    teams: TEAM_DEFS.map(t => ({ id: t.id, name: t.name, budget: INITIAL_BUDGET, players: [] })),
    // Always start from clean master roster — runtime statuses are in data/player_statuses.json
    players: RAW_PLAYERS.map(p => ({ ...p, status: 'available', soldTo: null, soldPrice: null })),
    pendingPool: [],
    auction: {
      status: 'idle',
      currentPlayer: null,
      currentBid: 0,
      currentBidder: null,
      currentBidderName: null,
      timeLeft: BID_TIMER,
    },
    auctionLog: [],
    started: false,
  };
}

// ─── Data persistence ─────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// Files written:
//   data/team1.json, data/team2.json, … — one per team, updated on every sale
//   data/game.json                       — player statuses, pending pool, log

function teamFilePath(teamId) {
  return path.join(DATA_DIR, `${teamId}.json`);
}

function saveTeam(team) {
  const data = {
    id:      team.id,
    name:    team.name,
    budget:  team.budget,
    players: team.players,   // each entry has soldPrice set
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(teamFilePath(team.id), JSON.stringify(data, null, 2), 'utf8');
  console.log(`💾  Saved ${team.name} → data/${team.id}.json  (budget $${team.budget}, ${team.players.length} players)`);
}

function saveGame() {
  const data = {
    started:    state.started,
    auctionLog: state.auctionLog,
    savedAt:    new Date().toISOString(),
  };
  fs.writeFileSync(path.join(DATA_DIR, 'game.json'), JSON.stringify(data, null, 2), 'utf8');
}

// Pending pool gets its own file so it survives any crash independently
function savePendingPool() {
  const data = {
    players: state.pendingPool,
    count:   state.pendingPool.length,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(DATA_DIR, 'pending_pool.json'), JSON.stringify(data, null, 2), 'utf8');
  console.log(`💾  Saved pending_pool.json  (${state.pendingPool.length} players)`);
}

// Save player statuses back to the root players.json (same file loaded at startup)
function savePlayers() {
  fs.writeFileSync(playerStatusesPath, JSON.stringify(state.players, null, 2), 'utf8');
  console.log(`💾  Saved data/player_statuses.json  (${state.players.length} players)`);
}

// Call after every meaningful change (sale, reset, start)
function persistState() {
  state.teams.forEach(saveTeam);
  saveGame();
  savePendingPool();
  savePlayers();
}

// On startup: reload saved data back into state
function loadSavedState() {
  let any = false;

  const gameFile = path.join(DATA_DIR, 'game.json');
  if (fs.existsSync(gameFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(gameFile, 'utf8'));
      state.started     = saved.started     ?? false;
      state.auctionLog  = saved.auctionLog  ?? [];
      // Never restore a live auction mid-flight — reset to idle
      state.auction = { status: 'idle', currentPlayer: null, currentBid: 0,
                        currentBidder: null, currentBidderName: null, timeLeft: BID_TIMER };
      any = true;
      console.log(`📂  Loaded game.json  (started=${state.started}, pendingPool=${state.pendingPool.length})`);
    } catch (e) { console.warn('⚠️  Could not load game.json:', e.message); }
  }

  // Load runtime player statuses from data/ — falls back to RAW_PLAYERS on first run
  if (fs.existsSync(playerStatusesPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(playerStatusesPath, 'utf8'));
      state.players = saved;
      any = true;
      console.log(`📂  Loaded data/player_statuses.json  (${state.players.length} players)`);
    } catch (e) { console.warn('⚠️  Could not load data/player_statuses.json:', e.message); }
  }

  // Load pending pool from its own file (falls back to game.json if not present)
  const pendingFile = path.join(DATA_DIR, 'pending_pool.json');
  if (fs.existsSync(pendingFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
      state.pendingPool = saved.players ?? [];
      any = true;
      console.log(`📂  Loaded pending_pool.json  (${state.pendingPool.length} players)`);
    } catch (e) { console.warn('⚠️  Could not load pending_pool.json:', e.message); }
  }

  state.teams.forEach(team => {
    const fp = teamFilePath(team.id);
    if (fs.existsSync(fp)) {
      try {
        const saved = JSON.parse(fs.readFileSync(fp, 'utf8'));
        team.name    = saved.name    ?? team.name;
        team.budget  = saved.budget  ?? team.budget;
        team.players = saved.players ?? [];
        any = true;
        console.log(`📂  Loaded ${team.name}  (budget $${team.budget}, ${team.players.length} players)`);
      } catch (e) { console.warn(`⚠️  Could not load data/${team.id}.json:`, e.message); }
    }
  });

  if (!any) console.log('🆕  No saved data — starting fresh');
}

let state = createInitialState();
loadSavedState();
let auctionInterval = null;

// ─── Users ────────────────────────────────────────────────────────────────────
function getUsers() {
  const users = [{ id: 'admin', name: 'Admin', type: 'admin', teamId: null, needsPassword: true }];
  state.teams.forEach(t => users.push({ id: t.id, name: `${t.name} Owner`, type: 'owner', teamId: t.id, needsPassword: true }));
  users.push({ id: 'guest', name: 'Guest Viewer', type: 'guest', teamId: null, needsPassword: false });
  return users;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getMaxBid(team) {
  const remaining = Math.max(0, MIN_PLAYERS - team.players.length);
  if (remaining <= 1) return team.budget;
  return Math.max(0, team.budget - (remaining - 1) * MIN_PRICE);
}

function buildStatePayload() {
  return {
    teams:       state.teams.map(t => ({ ...t, maxBid: getMaxBid(t) })),
    players:     state.players,
    pendingPool: state.pendingPool,
    auction:     state.auction,
    auctionLog:  state.auctionLog.slice(0, 20),
    started:     state.started,
  };
}

function broadcastState() { io.emit('game_state', buildStatePayload()); }

function stopTimer() {
  if (auctionInterval) { clearInterval(auctionInterval); auctionInterval = null; }
}

function startBidTimer() {
  stopTimer();
  state.auction.timeLeft = BID_TIMER;
  // Note: caller is responsible for broadcastState() after this
  auctionInterval = setInterval(() => {
    state.auction.timeLeft--;
    io.emit('timer_tick', state.auction.timeLeft);
    if (state.auction.timeLeft <= 0) { stopTimer(); finalizeAuction(); }
  }, 1000);
}

function finalizeAuction() {
  const { currentPlayer, currentBid, currentBidder } = state.auction;
  if (!currentPlayer) return;

  if (currentBidder) {
    const team = state.teams.find(t => t.id === currentBidder);
    if (team) { team.budget -= currentBid; team.players.push({ ...currentPlayer, soldPrice: currentBid }); }
    const p = state.players.find(p => p.id === currentPlayer.id);
    if (p) { p.status = 'sold'; p.soldTo = currentBidder; p.soldPrice = currentBid; }
    state.auction.status = 'sold';
    state.auctionLog.unshift({ type: 'sold', player: currentPlayer.name, team: team?.name, price: currentBid, time: new Date().toLocaleTimeString() });
    io.emit('notification', { type: 'sold', message: `🎉 ${currentPlayer.name} SOLD to ${team?.name} for $${currentBid}!` });
    try { if (team) saveTeam(team); } catch(e) { console.error('saveTeam failed:',    e.message); }
    try { saveGame();               } catch(e) { console.error('saveGame failed:',    e.message); }
    try { savePlayers();            } catch(e) { console.error('savePlayers failed:', e.message); }
  } else {
    const p = state.players.find(p => p.id === currentPlayer.id);
    if (p) p.status = 'pending';
    if (!state.pendingPool.find(p => p.id === currentPlayer.id))
      state.pendingPool.push({ ...currentPlayer, status: 'pending' });
    state.auction.status = 'unsold';
    state.auctionLog.unshift({ type: 'unsold', player: currentPlayer.name, time: new Date().toLocaleTimeString() });
    io.emit('notification', { type: 'unsold', message: `😔 ${currentPlayer.name} went UNSOLD → Pending Pool` });
    try { saveGame();        } catch(e) { console.error('saveGame failed:',        e.message); }
    try { savePlayers();     } catch(e) { console.error('savePlayers failed:',     e.message); }
    try { savePendingPool(); } catch(e) { console.error('savePendingPool failed:', e.message); }
  }
  broadcastState();
}

// source: 'pending' | 'main'
function pickNextPlayer(source) {
  const pool = source === 'pending'
    ? state.pendingPool
    : state.players.filter(p => p.status === 'available');
  if (pool.length === 0) return null;

  const player = pool[Math.floor(Math.random() * pool.length)];

  // ── Update state FIRST, save to disk AFTER ──────────────────────────────────
  state.pendingPool = state.pendingPool.filter(p => p.id !== player.id);
  const main = state.players.find(p => p.id === player.id);
  if (main) main.status = 'inauction';
  state.auction = {
    status: 'running',
    currentPlayer: { ...player, status: 'inauction' },
    currentBid: player.basePrice,
    currentBidder: null,
    currentBidderName: null,
    timeLeft: BID_TIMER,
  };

  startBidTimer();  // start countdown — state is fully set before this

  // Persist after state is safely updated — errors here won't break the auction
  try { savePendingPool(); } catch(e) { console.error('savePendingPool failed:', e.message); }
  try { savePlayers();     } catch(e) { console.error('savePlayers failed:',     e.message); }

  return player;
}

// ─── REST ─────────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => res.json({ game: config.game }));
app.get('/api/users',  (req, res) => res.json(getUsers()));

app.post('/api/login', (req, res) => {
  const { userId, password } = req.body;
  const user = getUsers().find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.needsPassword) {
    const expected = PASSWORDS[userId];
    if (!expected)          return res.status(403).json({ error: 'No password configured' });
    if (password !== expected) return res.status(401).json({ error: 'Wrong password' });
  }
  res.json({ success: true, user });
});

app.post('/api/admin/rename-team', (req, res) => {
  const { teamId, name } = req.body;
  const team = state.teams.find(t => t.id === teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  team.name = name.trim();
  saveTeam(team);   // persist new name
  broadcastState();
  res.json({ success: true });
});

app.post('/api/admin/reset', (req, res) => {
  stopTimer();
  state = createInitialState();
  persistState();   // overwrite all data files with blank state
  broadcastState();
  io.emit('notification', { type: 'info', message: '🔄 Game has been reset!' });
  res.json({ success: true });
});

// ─── Sockets ──────────────────────────────────────────────────────────────────
const connectedUsers = new Map();

io.on('connection', (socket) => {
  socket.emit('game_state', buildStatePayload());

  socket.on('join', (userData) => {
    connectedUsers.set(socket.id, userData);
    io.emit('online_users', Array.from(connectedUsers.values()));
    console.log(`${userData.name} joined`);
  });

  socket.on('start_auction', () => {
    if (connectedUsers.get(socket.id)?.type !== 'admin') return;
    state.started = true;
    saveGame();   // persist started flag
    io.emit('notification', { type: 'info', message: '🏏 Auction started! Good luck!' });
    broadcastState();
  });

  socket.on('pick_player', () => {
    if (connectedUsers.get(socket.id)?.type !== 'admin') return;
    if (state.auction.status === 'running') return;

    const availableCount = state.players.filter(p => p.status === 'available').length;
    const pendingCount   = state.pendingPool.length;

    if (availableCount === 0 && pendingCount === 0) {
      io.emit('notification', { type: 'info', message: '🏆 All players have been auctioned!' });
      return;
    }

    // If no pending pool — skip the choice, just pick from main list directly
    if (pendingCount === 0) {
      pickNextPlayer('main');
      broadcastState();
      return;
    }

    // If no main list left — skip the choice, pick from pending pool directly
    if (availableCount === 0) {
      pickNextPlayer('pending');
      broadcastState();
      return;
    }

    // Both pools have players — ask admin to choose
    socket.emit('pick_source_choice', { pendingCount, availableCount });
  });

  // Admin responded with their chosen source
  socket.on('pick_player_from', ({ source }) => {
    if (connectedUsers.get(socket.id)?.type !== 'admin') return;
    if (state.auction.status === 'running') return;
    if (source !== 'pending' && source !== 'main') return;

    const availableCount = state.players.filter(p => p.status === 'available').length;
    const pendingCount   = state.pendingPool.length;

    // Guard: chosen pool might have emptied between choice and response
    if (source === 'pending' && pendingCount === 0) {
      socket.emit('notification', { type: 'info', message: 'Pending pool is now empty, picking from main list.' });
      source = 'main';
    }
    if (source === 'main' && availableCount === 0) {
      socket.emit('notification', { type: 'info', message: 'Main list is now empty, picking from pending pool.' });
      source = 'pending';
    }

    pickNextPlayer(source);
    broadcastState();
  });

  socket.on('force_sell', () => {
    if (connectedUsers.get(socket.id)?.type !== 'admin') return;
    if (state.auction.status !== 'running') return;
    stopTimer(); finalizeAuction();
  });

  socket.on('cancel_bid', () => {
    if (connectedUsers.get(socket.id)?.type !== 'admin') return;
    if (state.auction.status !== 'running') return;
    if (!state.auction.currentBidder) return;

    const cancelledTeam = state.auction.currentBidder;
    const cancelledAmount = state.auction.currentBid;

    // Reset bid back to base price, clear bidder
    state.auction.currentBid = state.auction.currentPlayer.basePrice;
    state.auction.currentBidder = null;
    state.auction.currentBidderName = null;

    // Restart timer
    startBidTimer();

    io.emit('notification', { type: 'info', message: `↩️ Last bid of $${cancelledAmount} cancelled — back to base price $${state.auction.currentBid}` });
    broadcastState();
  });

  socket.on('force_unsold', () => {
    if (connectedUsers.get(socket.id)?.type !== 'admin') return;
    if (state.auction.status !== 'running') return;
    stopTimer();
    state.auction.currentBidder = null;
    state.auction.currentBidderName = null;
    finalizeAuction();
  });

  socket.on('place_bid', ({ teamId, increment }) => {
    const user = connectedUsers.get(socket.id);
    if (!user || user.type !== 'owner' || user.teamId !== teamId) return;
    if (state.auction.status !== 'running') return;
    const team = state.teams.find(t => t.id === teamId);
    if (!team) return;
    if (state.auction.currentBidder === teamId) { socket.emit('bid_error', 'You are already the highest bidder!'); return; }

    // Bid = current price + chosen increment (must be > current bid if someone already bid)
    const inc = (typeof increment === 'number' && increment > 0) ? increment : 0;
    const bidAmount = state.auction.currentBid + inc;
    // Must be strictly greater than current bid if someone already bid
    if (state.auction.currentBidder !== null && bidAmount <= state.auction.currentBid) {
      socket.emit('bid_error', `Bid must be higher than current bid of $${state.auction.currentBid}`);
      return;
    }

    const maxBid = getMaxBid(team);
    if (bidAmount > maxBid)      { socket.emit('bid_error', `Exceeds your safe max bid of $${maxBid}!`); return; }
    if (bidAmount > team.budget) { socket.emit('bid_error', 'Insufficient budget!'); return; }

    state.auction.currentBid = bidAmount;
    state.auction.currentBidder = teamId;
    state.auction.currentBidderName = team.name;
    io.emit('notification', { type: 'bid', message: `💰 ${team.name} bid $${bidAmount} for ${state.auction.currentPlayer?.name}` });
    startBidTimer();
    broadcastState();
  });

  socket.on('disconnect', () => {
    connectedUsers.delete(socket.id);
    io.emit('online_users', Array.from(connectedUsers.values()));
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏏  Bay Area Premier League → http://localhost:${PORT}`);
  console.log(`    Passwords:`, Object.entries(PASSWORDS).map(([k,v]) => `${k}="${v}"`).join('  '));
  console.log();
});
