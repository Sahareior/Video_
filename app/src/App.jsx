// App.js
import { SignedIn, SignedOut, SignInButton, UserButton, useUser } from '@clerk/clerk-react';
import { useEffect, useRef, useState } from 'react';
import io from 'socket.io-client';
import Peer from 'peerjs';

/**
 * Replace these with your real hosts:
 * - SOCKET_HOST: where your Socket.IO backend is hosted (http(s)://...)
 * - PEER_HOST: hostname (no protocol) for PeerJS server (or full host if needed)
 */
const SOCKET_HOST = 'https://shorter-citizen-rush-derived.trycloudflare.com';
const PEER_HOST = 'disc-payroll-mill-pages.trycloudflare.com';
const PEER_PATH = '/peerjs';
const DEFAULT_ROOM = 'conference-room';

export default function App() {
  const { isLoaded, isSignedIn, user } = useUser();

  // UI state
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [usersInRoom, setUsersInRoom] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');
  const [myStream, setMyStream] = useState(null);
  const [peer, setPeer] = useState(null);
  const [userConnections, setUserConnections] = useState({});
  const [activeTab, setActiveTab] = useState('room');
  const [isLoading, setIsLoading] = useState(false);

  // Refs for mutable objects
  const peerRef = useRef(null);
  const myStreamRef = useRef(null);
  const callsRef = useRef(new Map());
  const audioElementsRef = useRef(new Map());
  const socketRef = useRef(null);

  // ---------- Initialize Socket.IO ----------
  useEffect(() => {
    setConnectionStatus('Connecting to server...');
    setIsLoading(true);

    const s = io(SOCKET_HOST, {
      transports: ['websocket', 'polling'],
      timeout: 10000,
      autoConnect: true
    });

    socketRef.current = s;
    setSocket(s);

    s.on('connect', () => {
      console.log('✅ Socket.io connected', s.id);
      setIsConnected(true);
      setIsLoading(false);
      setConnectionStatus('Connected to server ✅');
    });

    s.on('disconnect', (reason) => {
      console.log('❌ Socket.io disconnected:', reason);
      setIsConnected(false);
      setIsLoading(false);
      setConnectionStatus(`Disconnected: ${reason}`);
    });

    s.on('connect_error', (err) => {
      console.error('❌ Socket.io connect_error:', err);
      setIsLoading(false);
      setConnectionStatus(`Connection Error: ${err.message}`);
    });

    // When we receive the current list of users in the room
    s.on('current-users', (users) => {
      console.log('📋 current-users', users);
      const filtered = users.filter((id) => id !== user?.id);
      setUsersInRoom(filtered);

      // Initialize connection status for all users
      const initialConnections = {};
      filtered.forEach(userId => {
        initialConnections[userId] = 'disconnected';
      });
      setUserConnections(initialConnections);

      // Auto-call everyone when ready
      if (peerRef.current && myStreamRef.current) {
        filtered.forEach((userId) => {
          if (!callsRef.current.has(userId)) {
            setTimeout(() => {
              callUserInternal(userId, peerRef.current, myStreamRef.current);
            }, 1000);
          }
        });
      }
    });

    // A new user joined the room
    s.on('user-connected', (userId) => {
      console.log('👤 user-connected', userId);
      setUsersInRoom(prev => {
        const next = prev.includes(userId) ? prev : [...prev, userId];
        return next.filter(id => id !== user?.id);
      });

      setUserConnections(prev => ({
        ...prev,
        [userId]: 'disconnected'
      }));

      setTimeout(() => {
        if (peerRef.current && myStreamRef.current && userId !== user?.id && !callsRef.current.has(userId)) {
          console.log('📞 Auto-calling newly joined user:', userId);
          callUserInternal(userId, peerRef.current, myStreamRef.current);
        }
      }, 1500);
    });

    // A user left the room
    s.on('user-disconnected', (userId) => {
      console.log('👤 user-disconnected', userId);
      setUsersInRoom(prev => prev.filter(id => id !== userId));
      setUserConnections(prev => {
        const newConnections = { ...prev };
        delete newConnections[userId];
        return newConnections;
      });
      cleanupPeerCall(userId);
    });

    return () => {
      if (s) {
        s.close();
      }
      socketRef.current = null;
      setSocket(null);
    };
  }, [user?.id]);

  // ---------- Join room when signed-in and socket ready ----------
  useEffect(() => {
    if (socketRef.current && isConnected && isSignedIn && user) {
      console.log('🎯 joining default room as', user.id);
      socketRef.current.emit('join-default-room', user.id);
      setConnectionStatus(`Joined room as ${user.firstName} ✅`);
    }
  }, [isConnected, isSignedIn, user]);

  // ---------- Initialize audio + PeerJS ----------
  const initializeAudio = async () => {
    try {
      setIsLoading(true);
      setConnectionStatus('Requesting microphone access...');
      
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        },
        video: false
      });

      setMyStream(stream);
      myStreamRef.current = stream;
      setConnectionStatus('Microphone access granted ✅');

      // Initialize PeerJS
      const peerInstance = new Peer(user.id, {
        host: PEER_HOST,
        path: PEER_PATH,
        port: 443,
        secure: true,
        debug: 2,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
          ]
        }
      });

      peerRef.current = peerInstance;
      setPeer(peerInstance);

      peerInstance.on('open', (id) => {
        console.log('🔗 PeerJS open with id', id);
        setIsLoading(false);
        setConnectionStatus('PeerJS ready ✅');
        
        // Call all existing users once PeerJS is ready
        usersInRoom.forEach(userId => {
          if (userId !== user?.id && !callsRef.current.has(userId)) {
            setTimeout(() => {
              callUserInternal(userId, peerInstance, stream);
            }, 500);
          }
        });
      });

      peerInstance.on('error', (err) => {
        console.error('❌ PeerJS error', err);
        setIsLoading(false);
        setConnectionStatus(`PeerJS Error: ${err?.type || err?.message || 'unknown'}`);
      });

      // Someone is calling us
      peerInstance.on('call', (call) => {
        console.log('📞 incoming call from', call.peer);

        if (callsRef.current.has(call.peer)) {
          const existing = callsRef.current.get(call.peer);
          try { existing.close(); } catch (e) {}
        }

        call.answer(stream);
        setupCallHandlers(call);
      });

    } catch (err) {
      console.error('❌ Failed to get audio stream', err);
      setIsLoading(false);
      setConnectionStatus('Microphone access denied ❌');
      alert('Please allow microphone access to use audio features');
    }
  };

  // ---------- Make an outgoing call to a userId ----------
  const callUserInternal = (userId, peerInstance, localStream) => {
    if (!peerInstance || !localStream || userId === user?.id || callsRef.current.has(userId)) {
      return;
    }

    try {
      setUserConnections(prev => ({
        ...prev,
        [userId]: 'connecting'
      }));

      const call = peerInstance.call(userId, localStream);
      if (!call) {
        setUserConnections(prev => ({
          ...prev,
          [userId]: 'error'
        }));
        return;
      }
      setupCallHandlers(call);
    } catch (err) {
      console.error('❌ callUserInternal error', err);
      setUserConnections(prev => ({
        ...prev,
        [userId]: 'error'
      }));
    }
  };

  // ---------- Set up call handlers for a call ----------
  const setupCallHandlers = (call) => {
    const peerId = call.peer;
    console.log('🔧 Setting up call handlers for', peerId);

    callsRef.current.set(peerId, call);

    call.on('stream', (remoteStream) => {
      console.log('🔊 Received remote stream from', peerId);
      setUserConnections(prev => ({
        ...prev,
        [peerId]: 'connected'
      }));
      playRemoteStream(peerId, remoteStream);
    });

    const closeHandler = () => {
      console.log('📴 Call closed with', peerId);
      setUserConnections(prev => ({
        ...prev,
        [peerId]: 'disconnected'
      }));
      cleanupPeerCall(peerId);
    };

    call.on('close', closeHandler);
    call.on('error', (err) => {
      console.error('❌ Call error', peerId, err);
      setUserConnections(prev => ({
        ...prev,
        [peerId]: 'error'
      }));
      cleanupPeerCall(peerId);
    });
  };

  // ---------- Create an audio element and play remote stream ----------
  const playRemoteStream = (peerId, remoteStream) => {
    let audioEl = audioElementsRef.current.get(peerId);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
      audioElementsRef.current.set(peerId, audioEl);
    }
    audioEl.srcObject = remoteStream;
    audioEl.play().catch((err) => {
      console.warn('Autoplay prevented for audio from', peerId, err);
    });
  };

  // ---------- Cleanup a specific peer call ----------
  const cleanupPeerCall = (peerId) => {
    const call = callsRef.current.get(peerId);
    if (call) {
      try { call.close(); } catch (e) {}
      callsRef.current.delete(peerId);
    }

    const audioEl = audioElementsRef.current.get(peerId);
    if (audioEl) {
      try {
        audioEl.pause();
        audioEl.srcObject = null;
        if (audioEl.parentNode) audioEl.parentNode.removeChild(audioEl);
      } catch (e) {}
      audioElementsRef.current.delete(peerId);
    }
  };

  // ---------- Public function to call a user from UI ----------
  const callUser = (userId) => {
    if (!peerRef.current || !myStreamRef.current) {
      alert('Please start audio first');
      return;
    }
    if (userId === user?.id) return;
    console.log('📞 Calling user:', userId);
    callUserInternal(userId, peerRef.current, myStreamRef.current);
  };

  // ---------- Reconnect to all users ----------
  const reconnectToAll = () => {
    if (!peerRef.current || !myStreamRef.current) return;
    
    setConnectionStatus('Reconnecting to all users...');
    
    usersInRoom.forEach(userId => {
      if (userId !== user?.id) {
        cleanupPeerCall(userId);
        setTimeout(() => {
          callUserInternal(userId, peerRef.current, myStreamRef.current);
        }, Math.random() * 1000);
      }
    });
  };

  // ---------- Stop audio & teardown ----------
  const stopAudio = () => {
    setConnectionStatus('Stopping audio and closing connections...');
    
    if (myStreamRef.current) {
      myStreamRef.current.getTracks().forEach((t) => t.stop());
      myStreamRef.current = null;
      setMyStream(null);
    }

    if (peerRef.current) {
      try { peerRef.current.destroy(); } catch (e) { console.warn(e); }
      peerRef.current = null;
      setPeer(null);
    }

    Array.from(callsRef.current.keys()).forEach((peerId) => cleanupPeerCall(peerId));
    callsRef.current.clear();
    audioElementsRef.current.clear();

    setUserConnections({});
    setConnectionStatus('Audio stopped');
  };

  const toggleAudio = () => {
    if (myStreamRef.current) {
      const audioTrack = myStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setConnectionStatus(audioTrack.enabled ? 'Unmuted 🔊' : 'Muted 🔇');
      }
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopAudio();
      if (socketRef.current) {
        try { socketRef.current.close(); } catch (e) {}
      }
    };
  }, []);

  // ---------- UI Components ----------
  const StatusIndicator = ({ status }) => {
    const statusConfig = {
      connected: { color: '#10B981', text: 'Connected', icon: '🔊' },
      connecting: { color: '#F59E0B', text: 'Connecting', icon: '🔄' },
      disconnected: { color: '#EF4444', text: 'Disconnected', icon: '🔇' },
      error: { color: '#DC2626', text: 'Error', icon: '❌' }
    };
    
    const config = statusConfig[status] || statusConfig.disconnected;
    
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span>{config.icon}</span>
        <span style={{ color: config.color, fontWeight: '600' }}>
          {config.text}
        </span>
      </div>
    );
  };

  const UserCard = ({ userId, connectionStatus: status }) => {
    const isSelf = userId === user?.id;
    
    return (
      <div className="user-card">
        <div className="user-card-header">
          <div className="user-avatar">
            {isSelf ? '👤' : '👥'}
          </div>
          <div className="user-info">
            <div className="user-name">
              {isSelf ? `${user.firstName} (You)` : `User`}
            </div>
            <div className="user-id">
              {userId.slice(0, 8)}...
            </div>
          </div>
          <StatusIndicator status={status} />
        </div>
        
        {!isSelf && (
          <div className="user-actions">
            <button
              onClick={() => callUser(userId)}
              disabled={status === 'connected' || !myStream}
              className={`action-btn ${status === 'connected' ? 'connected' : ''}`}
            >
              {status === 'connected' ? '✅ Connected' : '📞 Call'}
            </button>
          </div>
        )}
      </div>
    );
  };

  const ConnectionStatusBar = () => (
    <div className={`status-bar ${isConnected ? 'connected' : 'disconnected'}`}>
      <div className="status-content">
        <div className="status-indicator">
          <div className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`}></div>
          <span>{connectionStatus}</span>
        </div>
        <div className="room-info">
          <span>Room: {DEFAULT_ROOM}</span>
          <span>•</span>
          <span>Users: {usersInRoom.length + 1}</span>
        </div>
      </div>
    </div>
  );

  const AudioControls = () => (
    <div className="audio-controls">
      <h3>🎤 Audio Controls</h3>
      <div className="control-buttons">
        {!myStream ? (
          <button
            onClick={initializeAudio}
            disabled={isLoading}
            className="btn btn-primary"
          >
            {isLoading ? '🔄 Starting...' : '🎤 Start Audio'}
          </button>
        ) : (
          <>
            <button
              onClick={toggleAudio}
              className="btn btn-secondary"
            >
              {myStream.getAudioTracks()[0]?.enabled ? '🔇 Mute' : '🔊 Unmute'}
            </button>
            <button
              onClick={stopAudio}
              className="btn btn-warning"
            >
              ⏹️ Stop 
            </button>
            <button
              onClick={reconnectToAll}
              className="btn btn-tertiary"
            >
              🔄 Reconnect All
            </button>
          </>
        )}
      </div>
    </div>
  );

  const RoomView = () => (
    <div className="room-view">
      <div className="welcome-banner">
        <h2>🎧 Conference Room</h2>
        <p>Connect with everyone in the room automatically or manually call specific users</p>
      </div>

      <AudioControls />

      <div className="users-section">
        <div className="section-header">
          <h3>👥 Participants ({usersInRoom.length + 1})</h3>
          <div className="connection-stats">
            <span>Connected: {Object.values(userConnections).filter(s => s === 'connected').length}</span>
          </div>
        </div>

        <div className="users-grid">
          {/* Self card */}
          <UserCard 
            userId={user?.id} 
            connectionStatus="connected" 
          />
          
          {/* Other users */}
          {usersInRoom.map((userId) => (
            <UserCard
              key={userId}
              userId={userId}
              connectionStatus={userConnections[userId] || 'disconnected'}
            />
          ))}
        </div>

        {usersInRoom.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon">👥</div>
            <h4>No other users in the room</h4>
            <p>Open another browser window or invite others to join the conference</p>
          </div>
        )}
      </div>
    </div>
  );

  const DebugView = () => (
    <div className="debug-view">
      <h3>🔧 Debug Information</h3>
      <div className="debug-grid">
        <div className="debug-item">
          <label>Frontend:</label>
          <span>http://localhost:5173</span>
        </div>
        <div className="debug-item">
          <label>Socket Host:</label>
          <span>{SOCKET_HOST}</span>
        </div>
        <div className="debug-item">
          <label>Peer Host:</label>
          <span>{PEER_HOST}{PEER_PATH}</span>
        </div>
        <div className="debug-item">
          <label>User ID:</label>
          <span>{user?.id || 'Not signed in'}</span>
        </div>
        <div className="debug-item">
          <label>Socket Connected:</label>
          <span className={socket?.connected ? 'status-good' : 'status-bad'}>
            {socket?.connected ? 'Yes ✅' : 'No ❌'}
          </span>
        </div>
        <div className="debug-item">
          <label>Audio Stream:</label>
          <span className={myStream ? 'status-good' : 'status-bad'}>
            {myStream ? 'Available ✅' : 'Not available ❌'}
          </span>
        </div>
        <div className="debug-item">
          <label>PeerJS Ready:</label>
          <span className={peer ? 'status-good' : 'status-bad'}>
            {peer ? 'Yes ✅' : 'No ❌'}
          </span>
        </div>
        <div className="debug-item">
          <label>Active Calls:</label>
          <span>{callsRef.current.size}</span>
        </div>
      </div>
      
      <div className="debug-json">
        <h4>Raw Data:</h4>
        <pre>{JSON.stringify({
          usersInRoom,
          userConnections,
          activeCalls: Array.from(callsRef.current.keys())
        }, null, 2)}</pre>
      </div>
    </div>
  );

  // ---------- Main UI ----------
  return (
    <div className="app">
      <style jsx>{`
        .app {
          min-height: 100vh;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }

        .header {
          background: rgba(255, 255, 255, 0.95);
          backdrop-filter: blur(10px);
          padding: 1rem 2rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.2);
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        }

        .header-content {
          max-width: 1500px;
          margin: 0 auto;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .user-info {
          display: flex;
          align-items: center;
          gap: 1rem;
        }

        .welcome-text h1 {
          margin: 0;
          font-size: 1.5rem;
          color: #1f2937;
        }

        .welcome-text p {
          margin: 0;
          color: #6b7280;
          font-size: 0.9rem;
        }

        .status-bar {
          background: rgba(0, 0, 0, 0.8);
          color: white;
          padding: 0.75rem 2rem;
        }

        .status-bar.connected {
          background: rgba(16, 185, 129, 0.9);
        }

        .status-bar.disconnected {
          background: rgba(239, 68, 68, 0.9);
        }

        .status-content {
          max-width: 1200px;
          margin: 0 auto;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .status-indicator {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-weight: 600;
        }

        .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }

        .status-dot.connected {
          background: #10B981;
          box-shadow: 0 0 10px #10B981;
        }

        .status-dot.disconnected {
          background: #EF4444;
          box-shadow: 0 0 10px #EF4444;
        }

        .room-info {
          display: flex;
          gap: 0.5rem;
          font-size: 0.9rem;
          opacity: 0.9;
        }

        .main-content {
          max-width: 1200px;
          margin: 0 auto;
          padding: 2rem;
        }

        .tabs {
          display: flex;
          gap: 0.5rem;
          margin-bottom: 2rem;
          background: rgba(255, 255, 255, 0.1);
          padding: 0.5rem;
          border-radius: 12px;
          backdrop-filter: blur(10px);
        }

        .tab {
          padding: 0.75rem 1.5rem;
          border: none;
          background: transparent;
          color: white;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 600;
          transition: all 0.2s;
        }

        .tab.active {
          background: rgba(255, 255, 255, 0.2);
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }

        .tab:hover:not(.active) {
          background: rgba(255, 255, 255, 0.1);
        }

        .room-view, .debug-view {
          background: rgba(255, 255, 255, 0.95);
          border-radius: 16px;
          padding: 2rem;
          box-shadow: 0 10px 25px -3px rgba(0, 0, 0, 0.1);
          backdrop-filter: blur(10px);
        }

        .welcome-banner {
          text-align: center;
          margin-bottom: 2rem;
          padding: 2rem;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border-radius: 12px;
          color: white;
        }

        .welcome-banner h2 {
          margin: 0 0 0.5rem 0;
          font-size: 2rem;
        }

        .welcome-banner p {
          margin: 0;
          opacity: 0.9;
          font-size: 1.1rem;
        }

        .audio-controls {
          background: #f8fafc;
          padding: 1.5rem;
          border-radius: 12px;
          margin-bottom: 2rem;
          border: 1px solid #e2e8f0;
        }

        .audio-controls h3 {
          margin: 0 0 1rem 0;
          color: #1f2937;
        }

        .control-buttons {
          display: flex;
          gap: 0.75rem;
          flex-wrap: wrap;
        }

        .btn {
          padding: 0.75rem 1.5rem;
          border: none;
          border-radius: 8px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          font-size: 0.9rem;
        }

        .btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .btn-primary {
          background: #10B981;
          color: white;
        }

        .btn-primary:hover:not(:disabled) {
          background: #059669;
          transform: translateY(-1px);
        }

        .btn-secondary {
          background: #3B82F6;
          color: white;
        }

        .btn-secondary:hover:not(:disabled) {
          background: #2563EB;
          transform: translateY(-1px);
        }

        .btn-warning {
          background: #EF4444;
          color: white;
        }

        .btn-warning:hover:not(:disabled) {
          background: #DC2626;
          transform: translateY(-1px);
        }

        .btn-tertiary {
          background: #8B5CF6;
          color: white;
        }

        .btn-tertiary:hover:not(:disabled) {
          background: #7C3AED;
          transform: translateY(-1px);
        }

        .users-section {
          background: #f8fafc;
          padding: 1.5rem;
          border-radius: 12px;
          border: 1px solid #e2e8f0;
        }

        .section-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1.5rem;
        }

        .section-header h3 {
          margin: 0;
          color: #1f2937;
        }

        .connection-stats {
          background: white;
          padding: 0.5rem 1rem;
          border-radius: 20px;
          font-size: 0.9rem;
          color: #6b7280;
          border: 1px solid #e5e7eb;
        }

        .users-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 1rem;
        }

        .user-card {
          background: white;
          border: 1px solid #e5e7eb;
          border-radius: 12px;
          padding: 1.25rem;
          transition: all 0.2s;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        }

        .user-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        }

        .user-card-header {
          display: flex;
          align-items: center;
          gap: 1rem;
          margin-bottom: 1rem;
        }

        .user-avatar {
          width: 48px;
          height: 48px;
          background: #f3f4f6;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 1.25rem;
        }

        .user-info {
          flex: 1;
        }

        .user-name {
          font-weight: 600;
          color: #1f2937;
          margin-bottom: 0.25rem;
        }

        .user-id {
          font-size: 0.8rem;
          color: #6b7280;
          font-family: monospace;
        }

        .user-actions {
          display: flex;
          justify-content: flex-end;
        }

        .action-btn {
          padding: 0.5rem 1rem;
          border: none;
          border-radius: 6px;
          font-size: 0.8rem;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }

        .action-btn:not(.connected) {
          background: #10B981;
          color: white;
        }

        .action-btn.connected {
          background: #d1fae5;
          color: #065f46;
          cursor: default;
        }

        .action-btn:not(.connected):hover {
          background: #059669;
          transform: translateY(-1px);
        }

        .empty-state {
          text-align: center;
          padding: 3rem 2rem;
          color: #6b7280;
        }

        .empty-icon {
          font-size: 3rem;
          margin-bottom: 1rem;
        }

        .empty-state h4 {
          margin: 0 0 0.5rem 0;
          color: #374151;
        }

        .debug-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
          gap: 1rem;
          margin-bottom: 2rem;
        }

        .debug-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 1rem;
          background: #f8fafc;
          border-radius: 8px;
          border: 1px solid #e2e8f0;
        }

        .debug-item label {
          font-weight: 600;
          color: #374151;
        }

        .status-good {
          color: #10B981;
          font-weight: 600;
        }

        .status-bad {
          color: #EF4444;
          font-weight: 600;
        }

        .debug-json {
          background: #1f2937;
          color: #e5e7eb;
          padding: 1rem;
          border-radius: 8px;
          font-family: monospace;
          font-size: 0.8rem;
          overflow-x: auto;
        }

        .debug-json h4 {
          margin: 0 0 1rem 0;
          color: #9ca3af;
        }

        @media (max-width: 768px) {
          .main-content {
            padding: 1rem;
          }
          
          .header-content {
            flex-direction: column;
            gap: 1rem;
            text-align: center;
          }
          
          .control-buttons {
            flex-direction: column;
          }
          
          .users-grid {
            grid-template-columns: 1fr;
          }
          
          .section-header {
            flex-direction: column;
            gap: 1rem;
            align-items: flex-start;
          }
          
          .status-content {
            flex-direction: column;
            gap: 0.5rem;
            text-align: center;
          }
        }
      `}</style>

      <header className="header">
        <div className="header-content">
          <div className="user-info">
            <SignedOut>
              <SignInButton />
            </SignedOut>
            <SignedIn>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <UserButton />
                <div className="welcome-text">
                  <h1>Welcome, {user?.firstName}!</h1>
                  <p>Real-time Audio Conference</p>
                </div>
              </div>
            </SignedIn>
          </div>
        </div>
      </header>

      <ConnectionStatusBar />

      <SignedIn>
        <div className="main-content">
          <div className="tabs">
            <button 
              className={`tab ${activeTab === 'room' ? 'active' : ''}`}
              onClick={() => setActiveTab('room')}
            >
              🎧 Conference Room
            </button>
            <button 
              className={`tab ${activeTab === 'debug' ? 'active' : ''}`}
              onClick={() => setActiveTab('debug')}
            >
              🔧 Debug Info
            </button>
          </div>

          {activeTab === 'room' ? <RoomView /> : <DebugView />}

          {/* Instructions */}
          <div className="room-view" style={{ marginTop: '2rem' }}>
            <h3>🎯 How to Use</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1rem', marginTop: '1rem' }}>
              <div style={{ padding: '1rem', background: '#f0f9ff', borderRadius: '8px' }}>
                <h4 style={{ margin: '0 0 0.5rem 0', color: '#0369a1' }}>1. Start</h4>
                <p style={{ margin: 0, color: '#475569', fontSize: '0.9rem' }}>Click "Start Audio" to enable your microphone and join the conference</p>
              </div>
              <div style={{ padding: '1rem', background: '#f0fdf4', borderRadius: '8px' }}>
                <h4 style={{ margin: '0 0 0.5rem 0', color: '#166534' }}>2. Auto-Connect</h4>
                <p style={{ margin: 0, color: '#475569', fontSize: '0.9rem' }}>Users automatically connect when they join the room</p>
              </div>
              <div style={{ padding: '1rem', background: '#fef7cd', borderRadius: '8px' }}>
                <h4 style={{ margin: '0 0 0.5rem 0', color: '#854d0e' }}>3. Test</h4>
                <p style={{ margin: 0, color: '#475569', fontSize: '0.9rem' }}>Open another browser window to test with multiple users</p>
              </div>
            </div>
          </div>
        </div>
      </SignedIn>
    </div>
  );
}