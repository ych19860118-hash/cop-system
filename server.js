const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 房間資料庫 (記憶體儲存)
let rooms = {};

io.on('connection', (socket) => {
    
    socket.on('join_room', (data) => {
        socket.join(data.roomName);
        
        // 核心對接：綁定名稱與房間
        socket.myName = data.username;
        socket.myRoom = data.roomName;

        if (!rooms[data.roomName]) {
            rooms[data.roomName] = { objects: [], chatHistory: [], userList: [] };
        }
        
        // 確保存入 { id, name }
        rooms[data.roomName].userList.push({ id: socket.id, name: data.username });

        // 發送資料
        io.to(data.roomName).emit('update_user_list', rooms[data.roomName].userList);
        socket.emit('history_objects', rooms[data.roomName].objects);
    });

    socket.on('send_chat', (msg) => {
        if (!socket.myRoom) return;
        const chatData = { name: socket.myName, text: msg, time: new Date().toLocaleTimeString() };
        io.to(socket.myRoom).emit('new_chat_message', chatData);
    });

    socket.on('new_object', (objData) => {
        if (!socket.myRoom || !rooms[socket.myRoom]) return;
        rooms[socket.myRoom].objects.push(objData);
        io.to(socket.myRoom).emit('object_added', objData);
    });

    socket.on('disconnect', () => {
        if (!socket.myRoom || !rooms[socket.myRoom]) return;
        rooms[socket.myRoom].userList = rooms[socket.myRoom].userList.filter(u => u.id !== socket.id);
        io.to(socket.myRoom).emit('update_user_list', rooms[socket.myRoom].userList);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`伺服器啟動於 port ${PORT}`));
