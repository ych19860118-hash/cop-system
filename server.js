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

// --- 共用 API Key 驗證 ---
const getApiKey = () => process.env.CWA_API_KEY;

// --- 1. 地震資料 ---
app.get('/api/earthquake/data', async (req, res) => {
    const CWA_KEY = getApiKey();
    if (!CWA_KEY) return res.status(500).json({ error: "未設定 API Key" });
    try {
        const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/E-A0016-001?Authorization=${CWA_KEY}`;
        const response = await axios.get(url, { timeout: 5000 });
        res.json(response.data.records.Earthquake || []);
    } catch (error) {
        res.status(502).json({ error: "無法取得地震資料" });
    }
});

// --- 2. 即時氣象觀測 ---
app.get('/api/weather/data', async (req, res) => {
    const CWA_KEY = getApiKey();
    if (!CWA_KEY) return res.status(500).json({ error: "未設定 API Key" });
    try {
        const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0002-001?Authorization=${CWA_KEY}&format=JSON`;
        const response = await axios.get(url, { timeout: 5000 });
        res.json(response.data);
    } catch (error) {
        res.status(502).json({ error: "無法取得氣象資料" });
    }
});

// --- 3. 新增：縣市天氣預報 (F-C0032-001) ---
app.get('/api/weather/forecast', async (req, res) => {
    const CWA_KEY = getApiKey();
    if (!CWA_KEY) return res.status(500).json({ error: "未設定 API Key" });
    try {
        const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-C0032-001?Authorization=${CWA_KEY}`;
        const response = await axios.get(url, { timeout: 5000 });
        res.json(response.data);
    } catch (error) {
        console.error("預報 API 錯誤:", error.message);
        res.status(502).json({ error: "無法取得預報資料" });
    }
});

// --- 頻道與 Socket 邏輯 (維持不變) ---
let rooms = {
    "公開頻道(風災)": { password: "", objects: [], events: [], chatHistory: [] }, 
    "公開頻道(震災)": { password: "", objects: [], events: [], chatHistory: [] }
};
const ADMIN_SECRET = "adminyu"; 

app.post('/api/login', async (req, res) => {
    const { username, password, roomName, roomPassword, adminSecret } = req.body;
    const rName = roomName || "公開頻道(風災)";
    let uName = username || "";

    if (uName === "") return res.json({ success: false, message: "請輸入暱稱" });
    if (uName.toLowerCase() === 'admin') {
        if (!adminSecret || adminSecret !== ADMIN_SECRET) return res.json({ success: false, message: "密鑰錯誤" });
        uName = "管理者[Admin]";
    }

    if (!rooms[rName]) {
        rooms[rName] = { password: roomPassword || "", objects: [], events: [], chatHistory: [] };
    } else if (rooms[rName].password !== "" && rooms[rName].password !== roomPassword) {
        return res.json({ success: false, message: "密碼錯誤" });
    }
    res.json({ success: true, username: uName, roomName: rName });
});

io.on('connection', (socket) => {
    socket.on('join_room', (data) => {
        socket.join(data.roomName);
        socket.myRoom = data.roomName;
        socket.emit('history_objects', rooms[data.roomName]?.objects || []);
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
