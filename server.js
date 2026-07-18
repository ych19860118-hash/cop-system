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

// --- 新增：地震資料獲取功能 ---
async function fetchEarthquakeData() {
    try {
        const CWA_KEY = process.env.CWA_API_KEY; 
        if (!CWA_KEY) return [];
        const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/E-A0016-001?Authorization=${CWA_KEY}`;
        const response = await axios.get(url, { timeout: 5000 });
        return response.data.records.Earthquake || [];
    } catch (error) {
        console.error("抓取地震失敗:", error.message);
        return [];
    }
}

app.get('/api/earthquake/data', async (req, res) => {
    const data = await fetchEarthquakeData();
    res.json(data);
});
// --- 地震功能結束 ---

app.get('/api/weather/data', async (req, res) => {
    const CWA_KEY = process.env.CWA_API_KEY;
    if (!CWA_KEY) return res.status(500).json({ error: "伺服器未設定 API Key" });
    try {
        const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0002-001?Authorization=${CWA_KEY}&format=JSON`;
        const response = await axios.get(url, { timeout: 5000 });
        res.json(response.data);
    } catch (error) {
        res.status(502).json({ error: "無法取得氣象資料" });
    }
});

let rooms = {
    "公開頻道(風災)": { password: "", objects: [], events: [], chatHistory: [] }, 
    "公開頻道(震災)": { password: "", objects: [], events: [], chatHistory: [] }
};
let chatHistoryBackups = {}; 
let roomTimers = {}; 
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
        socket.myName = data.username;
        socket.emit('history_objects', rooms[data.roomName]?.objects || []);
    });
    
    // 其他原有的邏輯保持不變...
    socket.on('new_object', (objData) => { if (rooms[socket.myRoom]) { rooms[socket.myRoom].objects.push(objData); io.to(socket.myRoom).emit('object_added', objData); }});
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`伺服器啟動於 port ${PORT}`));
