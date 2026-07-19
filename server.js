const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const axios = require('axios');

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 輔助：格式化時間
function getFormattedTime() {
    return new Date().toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

// 全域房間狀態
let rooms = {
    "公開頻道(訪客)無須密碼": { password: "", objects: [], chatHistory: [], userList: [], lastActive: Date.now() }, 
    "公開頻道(風災)無須密碼": { password: "", objects: [], chatHistory: [], userList: [], lastActive: Date.now() }
};

// 登入 API
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

// Socket 事件處理
io.on('connection', (socket) => {
    
    socket.on('join_room', (data) => {
        socket.join(data.roomName);
        
        // 1. 綁定資訊到 socket，確保 send_chat 和 disconnect 可讀取
        socket.myName = data.username;
        socket.myRoom = data.roomName;

        if (!rooms[data.roomName]) {
            rooms[data.roomName] = { objects: [], chatHistory: [], userList: [], lastActive: Date.now() };
        }
        
        // 2. 加入用戶列表
        rooms[data.roomName].userList.push({ id: socket.id, name: data.username });
        rooms[data.roomName].lastActive = Date.now();

        // 3. 同步列表與歷史資料
        io.to(data.roomName).emit('update_user_list', rooms[data.roomName].userList);
        io.to(data.roomName).emit('update_user_count', rooms[data.roomName].userList.length);
        socket.emit('history_objects', rooms[data.roomName].objects);
    });

    socket.on('send_chat', (msg) => {
        if (!socket.myRoom || !rooms[socket.myRoom]) return;
        
        const chatData = { name: socket.myName, text: msg, time: getFormattedTime() };
        rooms[socket.myRoom].chatHistory.push(chatData);
        rooms[socket.myRoom].lastActive = Date.now();
        
        io.to(socket.myRoom).emit('new_chat_message', chatData);
    });

    socket.on('new_object', (objData) => { 
        if (socket.myRoom && rooms[socket.myRoom]) { 
            rooms[socket.myRoom].objects.push(objData); 
            rooms[socket.myRoom].lastActive = Date.now();
            io.to(socket.myRoom).emit('object_added', objData); 
        }
    });

    socket.on('delete_object', (objId) => {
        const room = rooms[socket.myRoom];
        if (room && room.objects) {
            room.objects = room.objects.filter(o => o.id !== objId);
            io.to(socket.myRoom).emit('object_removed', objId);
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
