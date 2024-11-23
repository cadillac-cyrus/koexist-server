const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;

// Create uploads directory if it doesn't exist
const uploadDir = path.join(__dirname, 'uploads', 'profile_photos');
(async () => {
  try {
    await fs.access(uploadDir);
  } catch {
    await fs.mkdir(uploadDir, { recursive: true });
    console.log('Created uploads directory:', uploadDir);
  }
})();

const app = express();
app.use(cors({
  origin: ["http://localhost:5173", "http://localhost:5174"],
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

// Enable pre-flight requests for all routes
app.options('*', cors());

// Serve static files from the uploads directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", "http://localhost:5174"],
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["my-custom-header"],
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'uploads/profile_photos'));
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const upload = multer({ 
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG and WebP are allowed.'));
    }
  }
});

// Store active users
const activeUsers = new Map();

// Health check endpoint
app.get('/health', (req, res) => {
  res.send('Server is running');
});

// Image upload endpoint
app.post('/api/upload', (req, res) => {
  console.log('Upload request received');
  console.log('Request headers:', req.headers);
  
  upload.single('image')(req, res, async (err) => {
    if (err) {
      console.error('Upload error:', err);
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: `Multer error: ${err.message}` });
      }
      return res.status(500).json({ error: err.message });
    }

    try {
      if (!req.file) {
        console.error('No file in request');
        return res.status(400).json({ error: 'No file uploaded' });
      }

      console.log('File details:', {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        path: req.file.path
      });

      const filePath = `/uploads/profile_photos/${req.file.filename}`;
      console.log('Returning file path:', filePath);
      res.json({ path: filePath });
    } catch (error) {
      console.error('Error processing upload:', error);
      res.status(500).json({ error: 'Failed to process file upload' });
    }
  });
});

// Delete image endpoint
app.delete('/api/delete-image', async (req, res) => {
  try {
    const { fileName } = req.body;
    if (!fileName) {
      return res.status(400).json({ error: 'No filename provided' });
    }

    const filePath = path.join(__dirname, 'uploads', 'profile_photos', fileName);
    await fs.unlink(filePath);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Error handling middleware for file uploads
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 5MB.' });
    }
  }
  console.error(err);
  res.status(500).json({ error: err.message });
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Log transport type
  console.log('Transport:', socket.conn.transport.name);

  // Handle transport change
  socket.conn.on('upgrade', () => {
    console.log('Transport upgraded:', socket.conn.transport.name);
  });

  // Handle user joining
  socket.on('user:join', (userData) => {
    console.log('User joining:', userData);
    try {
      activeUsers.set(socket.id, userData);
      io.emit('users:active', Array.from(activeUsers.values()));
      console.log('User joined successfully:', userData);
      console.log('Active users:', activeUsers.size);
    } catch (error) {
      console.error('Error in user:join:', error);
    }
  });

  // Handle private messages
  socket.on('message:private', ({ to, message }) => {
    console.log('Private message:', { to, message });
    try {
      const recipientSocket = Array.from(activeUsers.entries())
        .find(([_, user]) => user.uid === to)?.[0];
      
      if (recipientSocket) {
        io.to(recipientSocket).emit('message:receive', {
          from: activeUsers.get(socket.id),
          message
        });
        console.log('Private message sent successfully');
      } else {
        console.log('Recipient not found:', to);
      }
    } catch (error) {
      console.error('Error in message:private:', error);
    }
  });

  // Handle group messages
  socket.on('message:group', ({ chatId, message }) => {
    console.log('Group message:', { chatId, message });
    try {
      socket.to(chatId).emit('message:receive', {
        from: activeUsers.get(socket.id),
        message,
        chatId
      });
      console.log('Group message sent successfully');
    } catch (error) {
      console.error('Error in message:group:', error);
    }
  });

  // Handle joining chat rooms
  socket.on('chat:join', (chatId) => {
    console.log('Joining chat:', chatId);
    try {
      socket.join(chatId);
      console.log(`User ${socket.id} joined chat ${chatId}`);
    } catch (error) {
      console.error('Error in chat:join:', error);
    }
  });

  // Handle typing status
  socket.on('typing:start', ({ chatId, user }) => {
    try {
      socket.to(chatId).emit('typing:update', { user, isTyping: true });
    } catch (error) {
      console.error('Error in typing:start:', error);
    }
  });

  socket.on('typing:stop', ({ chatId, user }) => {
    try {
      socket.to(chatId).emit('typing:update', { user, isTyping: false });
    } catch (error) {
      console.error('Error in typing:stop:', error);
    }
  });

  // Handle errors
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });

  // Handle disconnection
  socket.on('disconnect', (reason) => {
    console.log('User disconnected:', socket.id, 'Reason:', reason);
    try {
      activeUsers.delete(socket.id);
      io.emit('users:active', Array.from(activeUsers.values()));
      console.log('Active users after disconnect:', activeUsers.size);
    } catch (error) {
      console.error('Error in disconnect handler:', error);
    }
  });
});

// Error handling for the server
server.on('error', (error) => {
  console.error('Server error:', error);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`CORS enabled for: ${["http://localhost:5173", "http://localhost:5174"].join(', ')}`);
  console.log(`Serving uploads from: ${path.join(__dirname, 'uploads')}`);
});
