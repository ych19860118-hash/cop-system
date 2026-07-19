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

// --- API 設定 ---
const getApiKey = () => process.env.CWA_API_KEY || 'CWA-2E7EC676-1235-48FF-906B-EAB529F3B533';

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

app.get('/api/weather/forecast', async (req, res) => {
    try {
        const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-C0032-001?Authorization=${getApiKey()}`;
        const response = await axios.get(url, { timeout: 5000 });
        res.json(response.data);
    } catch (error) { res.status(502).json({ error: "無法取得預報資料" }); }
});

// --- 頻道與 Socket 邏輯 ---
let rooms = {
    "公開頻道(風災)": { password: "", objects: [], events: [], users: 0 }, 
    "公開頻道(震災)": { password: "", objects: [], events: [], users: 0 }
};
const ADMIN_SECRET = "adminyu"; 

app.post('/api/login', (req, res) => {
    const { username, roomName, roomPassword, adminSecret } = req.body;
    const rName = roomName || "公開頻道(風災)";
    
    if (!username) return res.json({ success: false, message: "請輸入暱稱" });
    if (rooms[rName] && rooms[rName].password !== "" && rooms[rName].password !== roomPassword) {
        return res.json({ success: false, message: "密碼錯誤" });
    }
    res.json({ success: true, username, roomName: rName });
});

io.on('connection', (socket) => {
    socket.on('join_room', (data) => {
        socket.join(data.roomName);
        socket.myRoom = data.roomName;
        
        // 增加人數
        if (rooms[data.roomName]) {
            rooms[data.roomName].users = (rooms[data.roomName].users || 0) + 1;
            io.to(data.roomName).emit('update_user_count', rooms[data.roomName].users);
        }
        
        socket.emit('history_objects', rooms[data.roomName]?.objects || []);
    });

    socket.on('disconnect', () => {
        if (socket.myRoom && rooms[socket.myRoom]) {
            rooms[socket.myRoom].users = Math.max(0, rooms[socket.myRoom].users - 1);
            io.to(socket.myRoom).emit('update_user_count', rooms[socket.myRoom].users);
        }
    });

    socket.on('new_object', (objData) => { 
        if (rooms[socket.myRoom]) { 
            rooms[socket.myRoom].objects.push(objData); 
            io.to(socket.myRoom).emit('object_added', objData); 
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`伺服器啟動於 port ${PORT}`));
