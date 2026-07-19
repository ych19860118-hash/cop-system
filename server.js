const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const axios = require('axios');

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist')));

// --- API 輔助函式 (假設您有定義 getApiKey) ---
function getApiKey() { return process.env.CWA_API_KEY || ""; }

// --- API Endpoints ---
app.get('/api/earthquake/data', async (req, res) => {
    try {
        const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/E-A0016-001?Authorization=${getApiKey()}`;
        const response = await axios.get(url, { timeout: 5000 });
        res.json(response.data.records.Earthquake || []);
    } catch (error) { res.status(502).json({ error: "無法取得地震資料" }); }
});

// (Weather API 邏輯保持不變...)
let weatherCache = { data: null, lastFetch: 0 };
const CACHE_DURATION = 300000;
app.get('/api/weather/data', async (req, res) => {
    if (weatherCache.data && (Date.now() - weatherCache.lastFetch < CACHE_DURATION)) return res.json(weatherCache.data);
    try {
        const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0002-001?Authorization=${getApiKey()}&format=JSON`;
        const response = await axios.get(url, { timeout: 5000 });
        weatherCache.data = response.data;
        weatherCache.lastFetch = Date.now();
        res.json(response.data);
    } catch (error) { res.status(502).json({ error: "無法取得氣象資料" }); }
});

// --- 頻道與 Socket 邏輯 ---
let rooms = {
    "公開頻道(訪客)無須密碼": { password: "", objects: [], chatHistory: [], userList: [], lastActive: Date.now() }, 
    "公開頻道(風災)無須密碼": { password: "", objects: [], chatHistory: [], userList: [], lastActive: Date.now() }
};

// 自動清理機制
setInterval(() => {
    const EIGHT_HOURS = 8 * 60 * 60 * 1000;
    const now = Date.now();
    for (const roomName in rooms) {
        if (rooms[roomName].userList.length === 0 && (now - rooms[roomName].lastActive > EIGHT_HOURS)) {
            delete rooms[roomName];
        }
    }
}, 10 * 60 * 1000);

app.post('/api/login', (req, res) => {
    const { username, roomName, roomPassword } = req.body;
    if (!username) return res.json({ success: false, message: "請輸入暱稱" });
    if (!rooms[roomName]) rooms[roomName] = { password: "", objects: [], chatHistory: [], userList: [], lastActive: Date.now() };

    const room = rooms[roomName];
    const isPublic = roomName.includes("無須密碼");
    if (!isPublic && room.password !== "" && room.password !== roomPassword) {
        return res.json({ success: false, message: "密碼錯誤" });
    }
    res.json({ success: true, username, roomName });
});

io.on('connection', (socket) => {
    socket.on('join_room', (data) => {
        socket.join(data.roomName);
        socket.myRoom = data.roomName;
        socket.myName = data.username;

        if (!rooms[data.roomName]) rooms[data.roomName] = { objects: [], chatHistory: [], userList: [], lastActive: Date.now() };
        
        // 修正：確保加入的是純淨的物件，避免包含 socket 物件本身
        rooms[data.roomName].userList.push({ id: socket.id, name: data.username });
        rooms[data.roomName].lastActive = Date.now();

        // 廣播給該房間所有人
        io.to(data.roomName).emit('update_user_count', rooms[data.roomName].userList.length);
        io.to(data.roomName).emit('update_user_list', rooms[data.roomName].userList);
        
        socket.emit('history_objects', rooms[data.roomName].objects);
    });

    socket.on('delete_object', (objId) => {
        const room = rooms[socket.myRoom];
        if (room) {
            const index = room.findIndex(o => o.id === objId);
            if (index !== -1) {
                room.objects.splice(index, 1);
                room.lastActive = Date.now();
                // 修正：明確廣播刪除事件
                io.to(socket.myRoom).emit('object_removed', objId);
                console.log(`[同步] 物件 ${objId} 已在房間 ${socket.myRoom} 中刪除`);
            }
        }
    });

    socket.on('send_chat', (msg) => {
        if (!socket.myRoom || !rooms[socket.myRoom]) return;
        
        const chatData = { name: socket.myName, text: msg, time: new Date().toLocaleTimeString() };
        rooms[socket.myRoom].chatHistory.push(chatData);
        rooms[socket.myRoom].lastActive = Date.now();
        
        // 修正：確保聊天訊息發送至對應房間
        io.to(socket.myRoom).emit('new_chat_message', chatData);
    });

    socket.on('new_object', (objData) => { 
        if (socket.myRoom && rooms[socket.myRoom]) { 
            rooms[socket.myRoom].objects.push(objData); 
            rooms[socket.myRoom].lastActive = Date.now();
            io.to(socket.myRoom).emit('object_added', objData); 
        }
    });

    socket.on('disconnect', () => {
        if (socket.myRoom && rooms[socket.myRoom]) {
            rooms[socket.myRoom].userList = rooms[socket.myRoom].userList.filter(u => u.id !== socket.id);
            io.to(socket.myRoom).emit('update_user_list', rooms[socket.myRoom].userList);
            io.to(socket.myRoom).emit('update_user_count', rooms[socket.myRoom].userList.length);
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`伺服器啟動於 port ${PORT}`));
