const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 // Ye 100MB limit set kar dega
});

// In-Memory Databases (Zero-trace on server restart for absolute security)
const usersDB = {}; 
const statusesDB = {}; 
// Ye code socket.on('connection') se pehle daalein
app.get("/", (req, res) => {
    res.status(200).send("CalciChat Server is alive and running!");
});

io.on('connection', (socket) => {
    console.log("🟢 User connected: " + socket.id);

    // ==========================================
    // 1. REGISTRATION & LIVE PRESENCE
    // ==========================================
    socket.on('register', (data) => {
        const { userId, profilePic, bio, ninjaMode } = data;
        usersDB[userId] = { 
            socketId: socket.id, 
            profilePic: profilePic || (usersDB[userId] ? usersDB[userId].profilePic : null),
            bio: bio || (usersDB[userId] ? usersDB[userId].bio : "Hey there! I am using Secret App"),
            ninjaMode: ninjaMode || false,
            isOnline: true, 
            lastSeen: usersDB[userId] ? usersDB[userId].lastSeen : Date.now()
        };
        console.log(`👤 Registered -> ID: ${userId} | Ninja: ${ninjaMode ? 'ON' : 'OFF'}`);

        // Broadcast Online Status immediately (Live Presence)
        io.emit('presenceUpdate', { 
            userId: userId, 
            isOnline: !ninjaMode, 
            lastSeen: usersDB[userId].lastSeen 
        });
    });

    socket.on('getUserInfo', (targetId, callback) => {
        const user = usersDB[targetId];
        if (user) {
            callback({ 
                isOnline: user.ninjaMode ? false : user.isOnline, 
                lastSeen: user.ninjaMode ? null : user.lastSeen, 
                profilePic: user.profilePic, 
                bio: user.bio 
            });
        } else {
            callback({ isOnline: false, lastSeen: null, profilePic: null, bio: null });
        }
    });

    // ==========================================
    // 2. CORE MESSAGING (TEXT, MEDIA, VIEW-ONCE)
    // ==========================================
    socket.on('sendPrivateMessage', (data) => {
        const { targetId, senderId, message, id, type, replyTo, mediaDuration, isViewOnce, isMuted } = data; 
        const target = usersDB[targetId];
        
        if (target && target.socketId) { 
            io.to(target.socketId).emit('receiveMessage', { 
                senderId, message, id, type, replyTo, mediaDuration, isViewOnce, isMuted 
            });
            socket.emit('messageStatus', { id, status: 'delivered' });
        } else {
            socket.emit('messageStatus', { id, status: 'sent' });
        }
    });

    socket.on('messageSeen', (data) => {
        const { targetId, messageId, senderNinjaMode } = data;
        if (senderNinjaMode) return; 
        const sender = usersDB[targetId];
        if (sender && sender.socketId) {
            io.to(sender.socketId).emit('messageStatus', { id: messageId, status: 'seen' });
        }
    });

    // ==========================================
    // 3. EDIT, DELETE & REACTIONS
    // ==========================================
    socket.on('deleteMessages', (data) => {
        const { targetId, messageIds, forEveryone } = data;
        if (forEveryone) {
            const target = usersDB[targetId];
            if (target && target.socketId) io.to(target.socketId).emit('messagesDeleted', { messageIds });
        }
    });

    socket.on('editMessage', (data) => {
        const { targetId, messageId, newText } = data;
        const target = usersDB[targetId];
        if (target && target.socketId) io.to(target.socketId).emit('messageEdited', { messageId, newText });
    });

    socket.on('sendReaction', (data) => {
        const { targetId, messageId, reaction } = data;
        const target = usersDB[targetId];
        if (target && target.socketId) io.to(target.socketId).emit('receiveReaction', { messageId, reaction });
    });

    // ==========================================
    // 4. TYPING INDICATORS
    // ==========================================
    socket.on('typing', ({ targetId, senderId, ninjaMode }) => {
        if (ninjaMode) return; 
        const target = usersDB[targetId];
        if (target && target.socketId) io.to(target.socketId).emit('userTyping', { senderId });
    });

    socket.on('stopTyping', ({ targetId, senderId }) => {
        const target = usersDB[targetId];
        if (target && target.socketId) io.to(target.socketId).emit('userStoppedTyping', { senderId });
    });

    // ==========================================
    // 5. STATUS / STORIES (24-HOURS ENGINE)
    // ==========================================
    socket.on('postStatus', (data) => {
        const { userId, content, type } = data;
        if (!statusesDB[userId]) statusesDB[userId] = [];
        
        statusesDB[userId].push({
            id: Date.now().toString(),
            content, 
            type,
            timestamp: Date.now(),
            likes: [] 
        });
        io.emit('statusUpdated'); 
    });

    socket.on('getStatuses', (userId, callback) => {
        const now = Date.now();
        const validStatuses = {};
        
        for (let uid in statusesDB) {
            // Delete statuses older than 24 hours (86,400,000 ms)
            statusesDB[uid] = statusesDB[uid].filter(s => now - s.timestamp < 86400000);
            if (statusesDB[uid].length > 0) validStatuses[uid] = statusesDB[uid];
        }
        callback(validStatuses); 
    });

    socket.on('likeStatus', (data) => {
        const { targetId, statusId, likerId } = data;
        if (statusesDB[targetId]) {
            const status = statusesDB[targetId].find(s => s.id === statusId);
            if (status && !status.likes.includes(likerId)) {
                status.likes.push(likerId);
                io.emit('statusUpdated'); 
            }
        }
    });

    // ==========================================
    // 6. DISCONNECTION & OFFLINE BROADCAST
    // ==========================================
    socket.on('disconnect', () => {
        console.log("🔴 User disconnected: " + socket.id);
        for (const [userId, userData] of Object.entries(usersDB)) {
            if (userData.socketId === socket.id) {
                usersDB[userId].isOnline = false;
                usersDB[userId].lastSeen = Date.now();
                usersDB[userId].socketId = null; 
                
                // Broadcast Offline Status
                io.emit('presenceUpdate', { 
                    userId: userId, 
                    isOnline: false, 
                    lastSeen: usersDB[userId].lastSeen 
                });
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 CalciChat Secure Server is running on port ${PORT}`);
});
