import { SignedIn, SignedOut, SignInButton, UserButton, useUser } from '@clerk/clerk-react'
import { useEffect, useRef, useState } from 'react';
import io from 'socket.io-client';

export default function App() {
  const { isLoaded, isSignedIn, user } = useUser();
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [usersInRoom, setUsersInRoom] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');
  const [myStream, setMyStream] = useState(null);
  const [peer, setPeer] = useState(null);
  const peerInstance = useRef(null);
  const audioRef = useRef(null);

  // Initialize connection
  useEffect(() => {
    const initializeConnection = async () => {
      try {
        setConnectionStatus('Connecting to server...');
        
        // Test server connection first
        try {
          const healthResponse = await fetch('http://localhost:3001/health');
          if (!healthResponse.ok) {
            throw new Error('Server not responding');
          }
          const healthData = await healthResponse.json();
          console.log('✅ Server health:', healthData);
        } catch (error) {
          console.error('❌ Server health check failed:', error);
          setConnectionStatus('Server not running. Please start the backend server.');
          return;
        }
        
        // Initialize socket.io connection
        const newSocket = io('http://localhost:3001', {
          transports: ['websocket', 'polling'],
          timeout: 10000
        });

        newSocket.on('connect', () => {
          console.log('✅ Socket.io connected');
          setConnectionStatus('Connected to server ✅');
          setIsConnected(true);
        });

        newSocket.on('disconnect', (reason) => {
          console.log('❌ Socket.io disconnected:', reason);
          setConnectionStatus(`Disconnected: ${reason}`);
          setIsConnected(false);
        });

        newSocket.on('connect_error', (error) => {
          console.error('❌ Socket.io connection error:', error);
          setConnectionStatus(`Connection Error: ${error.message}`);
        });

        setSocket(newSocket);

        // Socket event handlers
        newSocket.on('user-connected', (userId) => {
          console.log('👤 User connected:', userId);
          setUsersInRoom(prev => [...prev.filter(id => id !== userId), userId]);
        });

        newSocket.on('user-disconnected', (userId) => {
          console.log('👤 User disconnected:', userId);
          setUsersInRoom(prev => prev.filter(id => id !== userId));
        });

        newSocket.on('current-users', (users) => {
          console.log('📋 Current users in room:', users);
          setUsersInRoom(users);
        });

      } catch (error) {
        console.error('❌ Failed to initialize connection:', error);
        setConnectionStatus(`Failed: ${error.message}`);
      }
    };

    initializeConnection();

    return () => {
      if (socket) {
        socket.close();
      }
      if (myStream) {
        myStream.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  // Join room when user signs in and socket is connected
  useEffect(() => {
    if (socket && isConnected && isSignedIn && user) {
      console.log('🎯 Joining default room as:', user.id);
      socket.emit('join-default-room', user.id);
      setConnectionStatus(`Joined room as ${user.firstName} ✅`);
    }
  }, [socket, isConnected, isSignedIn, user]);

  // Initialize audio with PeerJS
  const initializeAudio = async () => {
    try {
      setConnectionStatus('Requesting microphone access...');
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }, 
        video: false 
      });
      
      setMyStream(stream);
      setConnectionStatus('Microphone access granted ✅');
      
      console.log('🎤 Audio stream obtained');
      
      // Initialize PeerJS for audio calls
const Peer = (await import('peerjs')).default;
const peer = new Peer(user.id, {
  host: 'localhost',
  port: 3002,        // ← CHANGED FROM 3001 TO 3002
  path: '/peerjs',
  debug: 3
});

      peerInstance.current = peer;

      peer.on('open', (id) => {
        console.log('🔗 PeerJS connected with ID:', id);
        setConnectionStatus('Ready for audio calls ✅');
      });

      peer.on('error', (error) => {
        console.error('❌ PeerJS error:', error);
        setConnectionStatus(`PeerJS Error: ${error.type}`);
      });

      // Handle incoming audio calls
      peer.on('call', (call) => {
        console.log('📞 Incoming audio call from:', call.peer);
        setConnectionStatus(`Incoming call from ${call.peer}`);
        
        // Answer the call with our audio stream
        call.answer(stream);
        
        call.on('stream', (remoteStream) => {
          console.log('🔊 Received remote audio stream from:', call.peer);
          setConnectionStatus(`Audio connected to ${call.peer} ✅`);
          
          // Play the remote audio
          if (audioRef.current) {
            audioRef.current.srcObject = remoteStream;
          }
        });

        call.on('close', () => {
          console.log('📞 Call ended with:', call.peer);
          setConnectionStatus(`Call ended with ${call.peer}`);
        });
      });

      setPeer(peer);
      
    } catch (error) {
      console.error('❌ Failed to get audio stream:', error);
      setConnectionStatus('Microphone access denied ❌');
      alert('Please allow microphone access to use audio features');
    }
  };

  // Call another user
  const callUser = (userId) => {
    if (!peerInstance.current || !myStream) {
      console.log('Cannot call: Peer not initialized or no audio stream');
      return;
    }

    console.log('📞 Calling user:', userId);
    setConnectionStatus(`Calling ${userId}...`);
    
    const call = peerInstance.current.call(userId, myStream);
    
    call.on('stream', (remoteStream) => {
      console.log('🔊 Connected to user:', userId);
      setConnectionStatus(`Audio connected to ${userId} ✅`);
      
      if (audioRef.current) {
        audioRef.current.srcObject = remoteStream;
      }
    });

    call.on('error', (error) => {
      console.error('❌ Call error:', error);
      setConnectionStatus(`Call failed: ${error.message}`);
    });
  };

  const stopAudio = () => {
    if (myStream) {
      myStream.getTracks().forEach(track => track.stop());
      setMyStream(null);
      setConnectionStatus('Audio stopped');
    }
    if (peerInstance.current) {
      peerInstance.current.destroy();
      setPeer(null);
    }
  };

  const toggleAudio = () => {
    if (myStream) {
      const audioTrack = myStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setConnectionStatus(audioTrack.enabled ? 'Unmuted 🔊' : 'Muted 🔇');
      }
    }
  };

  return (
    <div>
      <header style={{ padding: '20px', borderBottom: '1px solid #ccc' }}>
        <SignedOut>
          <SignInButton />
        </SignedOut>
        <SignedIn>
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            <UserButton />
            <div>
              <p>Welcome, {user?.firstName}!</p>
              <p>Status: <strong>{connectionStatus}</strong></p>
              <p>Users in room: {usersInRoom.length}</p>
            </div>
          </div>
        </SignedIn>
      </header>

      <SignedIn>
        <div style={{ padding: '20px' }}>
          <h2>🎧 Audio Room</h2>
          
          {/* Connection Status */}
          <div style={{ 
            padding: '15px', 
            marginBottom: '20px',
            backgroundColor: isConnected ? '#4CAF50' : '#f44336',
            color: 'white',
            borderRadius: '8px',
            textAlign: 'center'
          }}>
            <h3>{isConnected ? '✅ Connected to Room' : '❌ Disconnected'}</h3>
            <p>{connectionStatus}</p>
          </div>

          {/* Audio Controls */}
          <div style={{ 
            marginBottom: '20px', 
            padding: '20px', 
            backgroundColor: '#f5f5f5', 
            borderRadius: '8px' 
          }}>
            <h3>🎤 Audio Controls:</h3>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '10px' }}>
              {!myStream ? (
                <button 
                  onClick={initializeAudio}
                  style={{ 
                    padding: '12px 20px',
                    backgroundColor: '#4CAF50',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '16px'
                  }}
                >
                  🎤 Start Audio
                </button>
              ) : (
                <>
                  <button 
                    onClick={toggleAudio}
                    style={{ 
                      padding: '12px 20px',
                      backgroundColor: '#2196F3',
                      color: 'white',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '16px'
                    }}
                  >
                    {myStream.getAudioTracks()[0]?.enabled ? '🔇 Mute' : '🔊 Unmute'}
                  </button>
                  <button 
                    onClick={stopAudio}
                    style={{ 
                      padding: '12px 20px',
                      backgroundColor: '#ff9800',
                      color: 'white',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '16px'
                    }}
                  >
                    ⏹️ Stop Audio
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Remote Audio (hidden but active) */}
          <audio 
            ref={audioRef} 
            autoPlay 
            style={{ display: 'none' }}
          />

          {/* Users in Room */}
          <div style={{ marginTop: '20px' }}>
            <h3>👥 Users in Room ({usersInRoom.length}):</h3>
            {usersInRoom.length === 0 ? (
              <p>No other users in the room. Open another browser window to test.</p>
            ) : (
              <div style={{ 
                display: 'grid', 
                gap: '10px', 
                gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' 
              }}>
                {usersInRoom.map((userId) => (
                  <div 
                    key={userId}
                    style={{ 
                      padding: '15px',
                      backgroundColor: userId === user?.id ? '#e3f2fd' : '#f9f9f9',
                      border: '2px solid',
                      borderColor: userId === user?.id ? '#2196F3' : '#ddd',
                      borderRadius: '8px'
                    }}
                  >
                    <strong>{userId === user?.id ? 'You 👤' : 'User'}</strong>
                    <br />
                    <small style={{ color: '#666', wordBreak: 'break-all' }}>
                      {userId}
                    </small>
                    <br />
                    <div style={{ marginTop: '10px' }}>
                      {userId !== user?.id && myStream && (
                        <button 
                          onClick={() => callUser(userId)}
                          style={{
                            padding: '8px 12px',
                            backgroundColor: '#4CAF50',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '12px'
                          }}
                        >
                          📞 Call User
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Debug Info */}
          <details style={{ marginTop: '30px', padding: '15px', border: '1px solid #ccc', borderRadius: '8px' }}>
            <summary style={{ cursor: 'pointer', fontWeight: 'bold' }}>🔧 Debug Information</summary>
            <div style={{ 
              fontFamily: 'monospace', 
              fontSize: '12px', 
              marginTop: '10px',
              padding: '10px',
              backgroundColor: '#f9f9f9',
              borderRadius: '4px'
            }}>
              <p><strong>Frontend:</strong> http://localhost:5173</p>
              <p><strong>Backend:</strong> http://localhost:3001</p>
              <p><strong>User ID:</strong> {user?.id || 'Not signed in'}</p>
              <p><strong>Socket Connected:</strong> {socket?.connected ? 'Yes ✅' : 'No ❌'}</p>
              <p><strong>Audio Stream:</strong> {myStream ? 'Available ✅' : 'Not available ❌'}</p>
              <p><strong>PeerJS Ready:</strong> {peer ? 'Yes ✅' : 'No ❌'}</p>
              <p><strong>Users List:</strong> {usersInRoom.join(', ') || 'None'}</p>
            </div>
          </details>

          {/* Instructions */}
          <div style={{ 
            marginTop: '20px', 
            padding: '15px', 
            backgroundColor: '#e8f5e8',
            border: '1px solid #4CAF50',
            borderRadius: '8px'
          }}>
            <h4>🎯 How to test audio calls:</h4>
            <ol>
              <li>Open another browser window (Chrome Incognito or Firefox)</li>
              <li>Navigate to http://localhost:5173</li>
              <li>Sign in with a different Clerk account</li>
              <li>Click "Start Audio" in both windows</li>
              <li>Click "Call User" on any user card to start audio call</li>
              <li>You should hear each other through your speakers/headphones</li>
            </ol>
          </div>
        </div>
      </SignedIn>
    </div>
  );
}