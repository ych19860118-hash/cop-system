const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const axios = require('axios'); // 確保已安裝: npm install axios

// 放大 JSON 請求主體容量限制
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

// 氣象資訊代理 API (已加入安全防禦)
app.get('/api/weather/data', async (req, res) => {
    const CWA_KEY = process.env.CWA_API_KEY;
    if (!CWA_KEY) {
        console.error("錯誤：未設定環境變數 CWA_API_KEY");
        return res.status(500).json({ error: "伺服器未設定 API Key" });
    }

    try {
        // 請求氣象資料，設定 5 秒超時避免伺服器掛起
        const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0002-001?Authorization=${CWA_KEY}&format=JSON`;
        const response = await axios.get(url, { timeout: 5000 });
        res.json(response.data);
    } catch (error) {
        console.error("氣象 API 請求失敗:", error.message);
        res.status(502).json({ error: "無法取得氣象資料" });
    }
});

// 開放本機套件路徑
app.use('/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist')));

// 核心記憶體資料庫
let rooms = {
    "公開頻道(風災)": { password: "", objects: [], events: [], chatHistory: [] }, 
    "公開頻道(震災)": { password: "", objects: [], events: [], chatHistory: [] }
};

let chatHistoryBackups = {}; 
let roomTimers = {}; 
const ADMIN_SECRET = "adminyu"; 

app.post('/api/login', async (req, res) => {
    const { username, password, roomName, roomPassword, adminSecret } = req.body;
    const rName = roomName ? roomName.trim() : "公開頻道(風災)";
    let uName = username ? username.trim() : "";

    if (uName === "") {
        return res.json({ success: false, message: "登入失敗：請輸入有效的通報暱稱！" });
    }

    if (uName.toLowerCase() === 'admin') {
        if (!adminSecret || adminSecret.trim() !== ADMIN_SECRET) {
            return res.json({ success: false, message: "登入失敗：管理者身份驗證密鑰錯誤！" });
        }
        uName = "管理者[Admin]";
    } else {
        const lowerName = uName.toLowerCase();
        if (lowerName.includes('admin') || lowerName.includes('管理者')) {
            return res.json({ success: false, message: "登入失敗：非管理員暱稱不得包含 'Admin' 或 '管理者' 字眼！" });
        }
    }

    if (!rooms[rName]) {
        rooms[rName] = { password: roomPassword ? roomPassword.trim() : "", objects: [], events: [], chatHistory: chatHistoryBackups[rName] || [] };
    } else {
        if (rooms[rName].password !== "" && rooms[rName].password !== roomPassword.trim()) {
            return res.json({ success: false, message: "登入失敗：該應變房間密碼錯誤！" });
        }
    }

    let isNameTaken = false;
    try {
        const sockets = await io.in(rName).fetchSockets();
        isNameTaken = sockets.some(s => s.myName === uName);
    } catch (e) {}

    if (isNameTaken) {
        return res.json({ success: false, message: `登入失敗：暱稱「${uName}」已被使用中！` });
    }

    if (roomTimers[rName]) {
        clearTimeout(roomTimers[rName]);
        delete roomTimers[rName];
    }

    res.json({ success: true, username: uName, roomName: rName });
});

io.on('connection', (socket) => {
    let myRoom = "";
    let myName = "";

    socket.on('join_room', (data) => {
        myRoom = data.roomName;
        myName = data.username;
        socket.myName = myName; 
        socket.myRoom = myRoom;
        socket.join(myRoom);

        if (roomTimers[myRoom]) { clearTimeout(roomTimers[myRoom]); delete roomTimers[myRoom]; }

        socket.emit('history_objects', rooms[myRoom] ? rooms[myRoom].objects : []);
        socket.emit('history_events', rooms[myRoom] ? rooms[myRoom].events : []);
        socket.emit('history_chats', rooms[myRoom] && rooms[myRoom].chatHistory ? rooms[myRoom].chatHistory : []);

        sendUserCount(myRoom);
        io.to(myRoom).emit('user_notification', { name: myName, action: 'joined' });
    });

    socket.on('share_my_gps', (gpsData) => { if (myRoom) { gpsData.username = myName; socket.to(myRoom).emit('peer_gps_updated', gpsData); }});
    socket.on('send_chat', (messageText) => {
        if (!myRoom || !messageText.trim()) return;
        const chatData = { sender: myName, message: messageText.trim(), time: new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) };
        if (rooms[myRoom]) {
            if (!rooms[myRoom].chatHistory) rooms[myRoom].chatHistory = [];
            rooms[myRoom].chatHistory.push(chatData);
        }
        io.to(myRoom).emit('receive_chat', chatData);
    });

    socket.on('new_object', (objData) => { if (rooms[myRoom]) { rooms[myRoom].objects.push(objData); io.to(myRoom).emit('object_added', objData); }});
    socket.on('new_event', (eventData) => {
        if (!rooms[myRoom]) return;
        const enrichedEvent = { id: 'evt_' + Date.now(), sender: myName, ...eventData, time: new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) };
        rooms[myRoom].events.push(enrichedEvent);
        io.to(myRoom).emit('event_added', enrichedEvent);
    });

    socket.on('delete_event', (eventId) => {
        if (!rooms[myRoom]) return;
        const isAdmin = socket.myName === "管理者[Admin]";
        if (isAdmin || rooms[myRoom].events.some(e => e.id === eventId && e.sender === socket.myName)) {
            rooms[myRoom].events = rooms[myRoom].events.filter(e => e.id !== eventId);
            io.to(myRoom).emit('event_deleted', eventId);
        }
    });

    socket.on('disconnect', async () => {
        if (!myRoom) return;
        io.to(myRoom).emit('user_notification', { name: myName, action: 'left' });
        sendUserCount(myRoom);
        const sockets = await io.in(myRoom).fetchSockets();
        if (sockets.length === 0) {
            roomTimers[myRoom] = setTimeout(() => {
                if (rooms[myRoom]) {
                    chatHistoryBackups[myRoom] = rooms[myRoom].chatHistory;
                    if (myRoom.includes("公開頻道")) { rooms[myRoom].objects = []; rooms[myRoom].events = []; }
                    else { delete rooms[myRoom]; }
                }
                delete roomTimers[myRoom];
            }, 8 * 60 * 60 * 1000);
        }
    });
});

async function sendUserCount(roomName) {
    try {
        const sockets = await io.in(roomName).fetchSockets();
        io.to(roomName).emit('update_user_count', sockets.length);
        io.to(roomName).emit('update_user_list', sockets.map(s => s.myName));
    } catch (e) {}
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`防災協同伺服器啟動於 port ${PORT}`);
});
