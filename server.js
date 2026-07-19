const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const axios = require('axios');

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 輔助函式：時間格式化
function getFormattedTime() {
    return new Date().toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

// 房間資料庫 (注意：伺服器重啟即會清空)
let rooms = {
    "公開頻道(訪客)無須密碼": { password: "", objects: [], chatHistory: [], userList: [], lastActive: Date.now() }, 
    "公開頻道(風災)無須密碼": { password: "", objects: [], chatHistory: [], userList: [], lastActive: Date.now() }
};

// 登入 API
app.post('/api/login', (req, res) => {
    const { username, roomName, roomPassword } = req.body;
    if (!username) return res.json({ success: false, message: "請輸入暱稱" });
    
    if (!rooms[roomName]) {
        rooms[roomName] = { password: "", objects: [], chatHistory: [], userList: [], lastActive: Date.now() };
    }

    const room = rooms[roomName];
    const isPublic = roomName.includes("無須密碼");
    if (!isPublic && room.password !== "" && room.password !== roomPassword) {
        return res.json({ success: false, message: "密碼錯誤" });
    }
    res.json({ success: true, username, roomName });
});

// Socket 連線處理
io.on('connection', (socket) => {
    
    socket.on('join_room', (data) => {
        socket.join(data.roomName);
        
        // 綁定暱稱與房間資訊到 socket 物件
        socket.myName = data.username;
        socket.myRoom = data.roomName;

        if (!rooms[data.roomName]) {
            rooms[data.roomName] = { objects: [], chatHistory: [], userList: [], lastActive: Date.now() };
        }
        
        // 加入使用者列表，強制使用 name 欄位
        rooms[data.roomName].userList.push({ id: socket.id, name: data.username });
        rooms[data.roomName].lastActive = Date.now();

        // 廣播給房間內所有人
        io.to(data.roomName).emit('update_user_list', rooms[data.roomName].userList);
        io.to(data.roomName).emit('update_user_count', rooms[data.roomName].userList.length);
        
        // 發送歷史資料給剛進來的人
        socket.emit('history_objects', rooms[data.roomName].objects);
    });

    socket.on('send_chat', (msg) => {
        if (!socket.myRoom || !rooms[socket.myRoom]) return;
        
        // 強制使用 socket.myName
        const chatData = { name: socket.myName || "匿名", text: msg, time: getFormattedTime() };
        rooms[socket.myRoom].chatHistory.push(chatData);
        
        io.to(socket.myRoom).emit('new_chat_message', chatData);
    });

    socket.on('new_object', (objData) => { 
        if (socket.myRoom && rooms[socket.myRoom]) { 
            rooms[socket.myRoom].objects.push(objData); 
            io.to(socket.myRoom).emit('object_added', objData); 
        }
    });

    socket.on('delete_object', (objId) => {
        if (socket.myRoom && rooms[socket.myRoom]) {
            rooms[socket.myRoom].objects = rooms[socket.myRoom].objects.filter(o => o.id !== objId);
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
