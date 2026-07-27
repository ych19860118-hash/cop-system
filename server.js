process.env.TZ = 'Asia/Taipei'; // 必須放在最上面，確保 Date 物件讀取到對應時區
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

// 狀態管理 (加入 events 屬性來儲存歷史事件)
let rooms = {
    "公開頻道(訪客)無須密碼": { password: "", objects: [], events: [], chatHistory: [], userList: [], lastActive: Date.now() }, 
    "公開頻道(風災)無須密碼": { password: "", objects: [], events: [], chatHistory: [], userList: [], lastActive: Date.now() }
};

// --- 自動清理機制 (每 15 分鐘檢查一次) ---
setInterval(() => {
    const EIGHT_HOURS = 8 * 60 * 60 * 1000;
    const now = Date.now();

    for (const roomName in rooms) {
        if (roomName.includes("公開頻道")) continue; // 1. 公開頻道直接略過不刪
        
        // 2. 非公開頻道：必須同時符合「超過 8 小時」且「線上人數為 0」才會被刪除
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
        const records = response.data.records;
        const earthquakes = records?.Earthquake || records?.地震 || [];
        res.json(earthquakes);
    } catch (error) { 
        console.error('地震 API 錯誤:', error.message);
        res.status(502).json({ error: "無法取得地震資料" }); 
    }
});

app.get('/api/weather/data', async (req, res) => {
    try {
        const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0003-001?Authorization=${getApiKey()}&format=JSON`;
        const response = await axios.get(url, { timeout: 5000 });
        res.json(response.data);
    } catch (error) { 
        console.error('氣象 API 錯誤:', error.message);
        res.status(502).json({ error: "無法取得氣象資料" }); 
    }
});

app.post('/api/login', (req, res) => {
    const { username, roomName, roomPassword } = req.body;
    if (!username) return res.json({ success: false, message: "請輸入暱稱" });
    
    if (!rooms[roomName]) {
        rooms[roomName] = { password: "", objects: [], events: [], chatHistory: [], userList: [], lastActive: Date.now() };
    }

    const room = rooms[roomName];
    const isPublic = roomName.includes("無須密碼");
    
    // 1. 檢查密碼
    if (!isPublic && room.password !== "" && room.password !== roomPassword) {
        return res.json({ success: false, message: "密碼錯誤" });
    }

    // 2. 【防呆機制】檢查該頻道內是否已經有相同暱稱的使用者
    if (room.userList.includes(username)) {
        return res.json({ success: false, message: "此暱稱在此頻道中已被使用，請更換暱稱" });
    }

    res.json({ success: true, username, roomName });
});

// --- Socket.io ---
io.on('connection', (socket) => {
    socket.on('join_room', (data) => {
        if (!rooms[data.roomName]) {
            rooms[data.roomName] = { password: "", objects: [], events: [], chatHistory: [], userList: [], lastActive: Date.now() };
        }

        // 雙重檢查：防止透過 Socket 直接繞過 API 登入
        if (rooms[data.roomName].userList.includes(data.username)) {
            socket.emit('receive_chat', { sender: "系統通知", message: "此暱稱已被使用，連線失敗", time: getFormattedTime() });
            return;
        }

        socket.join(data.roomName);
        socket.myName = data.username;
        socket.myRoom = data.roomName;
        
        rooms[data.roomName].userList.push(data.username);
        rooms[data.roomName].lastActive = Date.now();
        
        const joinMsg = { sender: "系統通知", message: `【${data.username}】已加入房間`, time: getFormattedTime() };
        rooms[data.roomName].chatHistory.push(joinMsg);
        io.to(data.roomName).emit('receive_chat', joinMsg);
        
        io.to(data.roomName).emit('update_user_list', rooms[data.roomName].userList);
        io.to(data.roomName).emit('update_user_count', rooms[data.roomName].userList.length);
        
        // 廣播給同房間其他人：某人進入頻道
        socket.to(data.roomName).emit('user_notification', {
            name: data.username,
            action: 'joined'
        });
        
        // 傳送歷史圖資物件
        socket.emit('history_objects', rooms[data.roomName].objects);
        
        // 傳送歷史即時事件
        socket.emit('history_events', rooms[data.roomName].events);
        
        // 傳送歷史聊天紀錄給剛加入的使用者
        socket.emit('history_chats', rooms[data.roomName].chatHistory);
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
        
        const chatData = { sender: socket.myName, message: msg, time: getFormattedTime() };
        rooms[socket.myRoom].chatHistory.push(chatData);
        
        io.to(socket.myRoom).emit('receive_chat', chatData);
    });

    // --- 圖資物件相關 ---
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
            io.to(socket.myRoom).emit('object_deleted', objId);
        }
    });

    // --- 即時事件回報相關 (新補上) ---
    socket.on('new_event', (evtData) => {
        if (socket.myRoom && rooms[socket.myRoom]) {
            rooms[socket.myRoom].lastActive = Date.now();
            rooms[socket.myRoom].events.push(evtData);
            io.to(socket.myRoom).emit('event_added', evtData);
        }
    });

    socket.on('delete_event', (eventId) => {
        if (socket.myRoom && rooms[socket.myRoom]) {
            rooms[socket.myRoom].lastActive = Date.now();
            rooms[socket.myRoom].events = rooms[socket.myRoom].events.filter(e => e.id !== eventId);
            io.to(socket.myRoom).emit('event_deleted', eventId);
        }
    });

    socket.on('disconnect', () => {
        if (socket.myRoom && rooms[socket.myRoom]) {
            if (socket.myName) {
                rooms[socket.myRoom].userList = rooms[socket.myRoom].userList.filter(u => u !== socket.myName);
                
                // 廣播給同房間其他人：某人離開頻道
                io.to(socket.myRoom).emit('user_notification', {
                    name: socket.myName,
                    action: 'left'
                });
            }
            io.to(socket.myRoom).emit('update_user_list', rooms[socket.myRoom].userList);
            io.to(socket.myRoom).emit('update_user_count', rooms[socket.myRoom].userList.length);
            io.to(socket.myRoom).emit('user_disconnected', socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`伺服器啟動於 port ${PORT}`));
