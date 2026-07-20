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

// 輔助函式
function getApiKey() { return process.env.CWA_API_KEY || ""; }
function getFormattedTime() {
    return new Date().toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

// 狀態管理
let rooms = {
    "公開頻道(訪客)無須密碼": { password: "", objects: [], chatHistory: [], userList: [], lastActive: Date.now() }, 
    "公開頻道(風災)無須密碼": { password: "", objects: [], chatHistory: [], userList: [], lastActive: Date.now() }
};

// --- 自動清理機制 (每 15 分鐘檢查一次) ---
// 非公開頻道在 8 小時閒置且無人時會被自動刪除
setInterval(() => {
    const EIGHT_HOURS = 8 * 60 * 60 * 1000;
    const now = Date.now();

    for (const roomName in rooms) {
        if (roomName.includes("公開頻道")) continue;
        if (now - rooms[roomName].lastActive > EIGHT_HOURS && rooms[roomName].userList.length === 0) {
            delete rooms[roomName];
            console.log(`[系統清理] 已刪除閒置頻道: ${roomName}`);
        }
    }
}, 15 * 60 * 1000);

// --- API Endpoints ---
app.get('/api/earthquake/data', async (req, res) => {
    try {
        const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/E-A0016-001?Authorization=${getApiKey()}`;
        const response = await axios.get(url, { timeout: 5000 });
        res.json(response.data.records.Earthquake || []);
    } catch (error) { res.status(502).json({ error: "無法取得地震資料" }); }
});

app.get('/api/weather/data', async (req, res) => {
    try {
        const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0002-001?Authorization=${getApiKey()}&format=JSON`;
        const response = await axios.get(url, { timeout: 5000 });
        res.json(response.data);
    } catch (error) { res.status(502).json({ error: "無法取得氣象資料" }); }
});

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

// --- Socket.io ---
io.on('connection', (socket) => {
    socket.on('join_room', (data) => {
        socket.join(data.roomName);
        socket.myName = data.username;
        socket.myRoom = data.roomName;

        if (!rooms[data.roomName]) {
            rooms[data.roomName] = { objects: [], chatHistory: [], userList: [], lastActive: Date.now() };
        }
        
        rooms[data.roomName].userList.push({ id: socket.id, name: data.username });
        rooms[data.roomName].lastActive = Date.now();
        
        io.to(data.roomName).emit('new_chat_message', {
            name: "系統通知",
            text: `【${data.username}】已加入房間`,
            time: getFormattedTime()
        });
        io.to(data.roomName).emit('update_user_list', rooms[data.roomName].userList);
        io.to(data.roomName).emit('update_user_count', rooms[data.roomName].userList.length);
        socket.emit('history_objects', rooms[data.roomName].objects);
    });

    // 即時位置廣播
    socket.on('update_location', (data) => {
        if (socket.myRoom) {
            socket.to(socket.myRoom).emit('user_moved', {
                id: socket.id,
                name: socket.myName,
                lat: data.lat,
                lng: data.lng
            });
        }
    });

    socket.on('send_chat', (msg) => {
        if (!socket.myRoom || !rooms[socket.myRoom]) return;
        rooms[socket.myRoom].lastActive = Date.now();
        const chatData = { name: socket.myName, text: msg, time: getFormattedTime() };
        rooms[socket.myRoom].chatHistory.push(chatData);
        io.to(socket.myRoom).emit('new_chat_message', chatData);
    });

    socket.on('new_object', (objData) => { 
        if (socket.myRoom && rooms[socket.myRoom]) { 
            rooms[socket.myRoom].lastActive = Date.now();
            rooms[socket.myRoom].objects.push(objData); 
            io.to(socket.myRoom).emit('object_added', objData); 
        }
    });

    socket.on('delete_object', (objId) => {
        if (socket.myRoom && rooms[socket.myRoom]) {
            rooms[socket.myRoom].lastActive = Date.now();
            rooms[socket.myRoom].objects = rooms[socket.myRoom].objects.filter(o => o.id !== objId);
            io.to(socket.myRoom).emit('object_removed', objId);
        }
    });

    socket.on('disconnect', () => {
        if (socket.myRoom && rooms[socket.myRoom]) {
            rooms[socket.myRoom].userList = rooms[socket.myRoom].userList.filter(u => u.id !== socket.id);
            io.to(socket.myRoom).emit('update_user_list', rooms[socket.myRoom].userList);
            io.to(socket.myRoom).emit('update_user_count', rooms[socket.myRoom].userList.length);
            io.to(socket.myRoom).emit('user_disconnected', socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`伺服器啟動於 port ${PORT}`));
