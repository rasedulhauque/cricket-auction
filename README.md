# 🏏 BPL Auction App

BPL cricket auction app for fun among friends over the same WiFi/network.

## Features

- 🔐 **3 user types**: Admin (password), Team Owners (no password), Guests (view-only)
- 🎲 **Live auction** with 15-second countdown timer
- 💰 **Smart max-bid** calculation (ensures teams can fill their 12-player squad)
- ⏳ **Pending pool** — unsold players re-enter for re-auction
- 📊 **Real-time statistics** visible to everyone
- 🔔 **Live notifications** for bids and sales via Socket.io
- 🌍 **36 international players** pre-loaded across all roles
- 📱 **Mobile-friendly** — works on phones too!

---

## Quick Start

### Option A — Docker (Recommended)

```bash
# Clone or copy the project folder
cd cricket-auction

# Build and start
docker-compose up --build

# App will be at:
#   Local:   http://localhost:3000
#   Network: http://<your-IP>:3000
```

### Option B — Node.js directly

```bash
cd cricket-auction
npm install
npm start
```

---

## Sharing with friends on same WiFi

1. Start the app (Docker or Node)
2. Find your machine's local IP:
   - **Mac/Linux**: `ifconfig | grep "inet "` → look for 192.168.x.x
   - **Windows**: `ipconfig` → look for IPv4 Address
3. Share `http://192.168.x.x:3000` with everyone
4. Each person opens the link on their phone/laptop

---

## How to Play

### Admin
1. Login as **Admin** (password: `admin`)
2. Rename the 4 teams if you want
3. Click **"Start Auction!"** when everyone is ready
4. Click **"Pick Next Player"** to randomly draw a player for auction
5. Watch owners bid in real-time
6. Timer auto-sells after 15 seconds of no new bids
7. Use **"Hammer Down"** to sell early, or **"Pass/Unsold"** to skip a player

### Team Owners
1. Select your team from the landing page (no password needed)
2. Go to the **Auction tab** to see live bidding
3. Click **"BID"** to place your bid — the system automatically prevents overbidding
4. The app shows your **max bid** based on remaining budget and players still needed

### Guests
- Just watch! You can see the **Statistics** tab in real-time

---

## Game Rules

| Rule | Value |
|------|-------|
| Starting budget per team | $3,750 |
| Min players per team | 12 |
| Minimum player price | $50 |
| Bid increment | $50 |
| Bid timer | 30 seconds |
| Teams | 4 |

### Max Bid Formula
```
Max Bid = Current Budget − (Players Still Needed − 1) × ₹50
```
This ensures a team always has enough to fill their remaining squad slots.

---

## Customization

- Change `ADMIN_PASSWORD` in `docker-compose.yml`
- Edit team names via the Admin panel before starting
- Edit `DEFAULT_PLAYERS` in `server.js` to add your own player list

---

## Tech Stack
- **Backend**: Node.js + Express + Socket.io
- **Frontend**: Vanilla HTML/CSS/JS (no build step needed)
- **Container**: Docker + Docker Compose
