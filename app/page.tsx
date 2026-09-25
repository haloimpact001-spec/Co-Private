// app/page.tsx
'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import Peer, { MediaConnection } from 'peerjs';
import { generateKey, exportKeyToBase64, importKeyFromBase64, encryptText, decryptText } from '@/lib/crypto';
import { 
  Phone, Video, PhoneOff, Mic, MicOff, VideoOff, User, 
  Image as ImageIcon, Send, Lock, MessageCircle, MoreVertical, Copy, 
  AlertCircle, X, Check, LogOut, Info, ShieldCheck, Share2 
} from 'lucide-react';

// --- Sound Effects System ---
const playSound = (type: 'load' | 'send' | 'receive' | 'call') => {
  try {
    if (typeof window === 'undefined') return;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const audioContext = new AudioCtx();
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    if (type === 'load') {
      oscillator.frequency.setValueAtTime(523.25, audioContext.currentTime);
      oscillator.frequency.setValueAtTime(659.25, audioContext.currentTime + 0.1);
      gainNode.gain.setValueAtTime(0.08, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.25);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.25);
    } else if (type === 'send') {
      oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
      gainNode.gain.setValueAtTime(0.05, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.1);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.1);
    } else if (type === 'receive') {
      oscillator.frequency.setValueAtTime(1046.5, audioContext.currentTime);
      gainNode.gain.setValueAtTime(0.05, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.15);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.15);
    } else if (type === 'call') {
      oscillator.frequency.setValueAtTime(440, audioContext.currentTime);
      gainNode.gain.setValueAtTime(0.08, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.4);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.4);
    }
  } catch {
    // Suppress audio policy exceptions cleanly
  }
};

// --- LocalStorage Helpers ---
const saveProfileToStorage = (profileBase64: string) => {
  if (typeof window !== 'undefined') localStorage.setItem('secretChat_profile', profileBase64);
};
const loadProfileFromStorage = (): string | null => {
  if (typeof window !== 'undefined') return localStorage.getItem('secretChat_profile');
  return null;
};
const clearProfileFromStorage = () => {
  if (typeof window !== 'undefined') localStorage.removeItem('secretChat_profile');
};

// --- Cryptographically strong room ID generator ---
const generateRoomId = (length = 8): string => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(length);
  if (typeof window !== 'undefined' && window.crypto) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 4294967295);
  }
  let out = '';
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
};

// --- Per-tab, per-room sender id ---
const getOrCreateSenderId = (roomKey: string): string => {
  if (typeof window === 'undefined') return `User_${Math.random().toString(36).substring(2, 7)}`;
  const storageKey = `secretChat_sender_${roomKey}`;
  const existing = sessionStorage.getItem(storageKey);
  if (existing) return existing;
  const fresh = `User_${Math.random().toString(36).substring(2, 7)}`;
  sessionStorage.setItem(storageKey, fresh);
  return fresh;
};

// --- URL fragment helpers ---
const readRoomAndKeyFromLocation = (): { room: string | null; key: string | null } => {
  if (typeof window === 'undefined') return { room: null, key: null };
  const hash = window.location.hash.startsWith('#') ? window.location.hash.substring(1) : window.location.hash;
  const params = new URLSearchParams(hash);
  return { room: params.get('room'), key: params.get('key') };
};

const buildShareUrl = (roomId: string, encodedKey: string): string => {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}${window.location.pathname}#room=${roomId}&key=${encodedKey}`;
};

// --- Audio Visualizer Component ---
const AudioVisualizer = ({ level }: { level: number }) => {
  return (
    <div className="flex items-center justify-center space-x-1 h-8 w-32">
      {[1, 2, 3, 4, 5, 6, 7].map((i) => {
        const waveOffset = Math.sin(i * 1.2) * 25;
        const h = Math.max(15, Math.min(100, level + waveOffset));
        return (
          <div 
            key={i} 
            className="w-1.5 bg-red-500 rounded-full transition-all duration-75 ease-out"
            style={{ height: `${h}%` }}
          />
        );
      })}
    </div>
  );
};

export default function SecretChat() {
  // --- Refs ---
  const fileInputRef = useRef<HTMLInputElement>(null);
  const profileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const myPeerIdRef = useRef<string | null>(null);
  const peerInstance = useRef<Peer | null>(null);
  const currentCall = useRef<MediaConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const animationRef = useRef<number>(0);
  const callMenuRef = useRef<HTMLDivElement>(null);
  const decryptedCacheRef = useRef<Record<string, string>>({});
  
  // Voice Note Refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  
  const profilePicRef = useRef<string>('');

  // --- Core State ---
  const [roomId, setRoomId] = useState<string | null>(null);
  const [cryptoKey, setCryptoKey] = useState<CryptoKey | null>(null);
  const [roomKeyBase64, setRoomKeyBase64] = useState<string>('');
  const [isJoined, setIsJoined] = useState(false);
  const [messages, setMessages] = useState<any[]>([]);
  const [inputText, setInputText] = useState('');
  const [viewingImage, setViewingImage] = useState<{ url: string; id: string } | null>(null);
  const [viewedImages, setViewedImages] = useState<Set<string>>(new Set());
  const [senderId, setSenderId] = useState<string>('');
  const [profilePic, setProfilePic] = useState<string>('');
  const [peerProfiles, setPeerProfiles] = useState<Record<string, string>>({});
  const [decryptedAudios, setDecryptedAudios] = useState<Record<string, string>>({});

  // --- Call State ---
  const [remotePeerId, setRemotePeerId] = useState<string | null>(null);
  const [callState, setCallState] = useState<'idle' | 'outgoing' | 'incoming' | 'connected' | 'declined' | 'failed'>('idle');
  const [callType, setCallType] = useState<'voice' | 'video'>('video');
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [incomingCallData, setIncomingCallData] = useState<{ call: MediaConnection; type: 'voice' | 'video'; callerId: string } | null>(null);
  const [connectionStatus, setConnectionStatus] = useState('Initializing...');
  const [callError, setCallError] = useState<string | null>(null);
  const [webrtcConnectionState, setWebrtcConnectionState] = useState<string>('new');

  const declineCallRef = useRef<() => void>(() => {});

  // --- Voice Note State ---
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);

  const callStateRef = useRef(callState);
  useEffect(() => { callStateRef.current = callState; }, [callState]);

  // --- UI State ---
  const [showLanding, setShowLanding] = useState(true);
  const [joinRoomId, setJoinRoomId] = useState('');
  const [joinRoomKey, setJoinRoomKey] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [showContent, setShowContent] = useState(false);
  const [showRoomDetails, setShowRoomDetails] = useState(false);
  const [showCallMenu, setShowCallMenu] = useState(false);
  const [animationPhase, setAnimationPhase] = useState(0);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Load saved profile
  useEffect(() => {
    const savedProfile = loadProfileFromStorage();
    if (savedProfile) {
      setProfilePic(savedProfile);
      profilePicRef.current = savedProfile;
    }
  }, []);

  useEffect(() => {
    profilePicRef.current = profilePic;
  }, [profilePic]);

  useEffect(() => {
    playSound('load');
    const timer = setTimeout(() => {
      setIsLoading(false);
      setTimeout(() => setShowContent(true), 150);
    }, 1000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const animate = () => {
      setAnimationPhase((prev) => (prev + 1) % 360);
      animationRef.current = requestAnimationFrame(animate);
    };
    animationRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationRef.current);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (callMenuRef.current && !callMenuRef.current.contains(e.target as Node)) {
        setShowCallMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const cleanupRecording = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = 0;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (currentCall.current) currentCall.current.close();
      if (localStreamRef.current) localStreamRef.current.getTracks().forEach((t) => t.stop());
      if (peerInstance.current) peerInstance.current.destroy();
      if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current);
      cleanupRecording();
    };
  }, [cleanupRecording]);

  const sendSystemMessage = useCallback(async (text: string) => {
    if (!cryptoKey || !roomId) return;
    const messageId = `${Date.now()}_sys_${Math.random().toString(36).substring(2, 6)}`;
    const encryptedPayload = await encryptText(text, cryptoKey);
    await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, messageId, encryptedPayload, senderId: 'SYSTEM', type: 'system' }),
    }).catch(() => {});
  }, [cryptoKey, roomId]);

  const initializePeer = useCallback(() => {
    if (peerInstance.current && !peerInstance.current.destroyed) return;

    const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
    const turnUsername = process.env.NEXT_PUBLIC_TURN_USERNAME;
    const turnCredential = process.env.NEXT_PUBLIC_TURN_CREDENTIAL;

    const iceServers: RTCIceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];
    if (turnUrl && turnUsername && turnCredential) {
      iceServers.push({ urls: turnUrl, username: turnUsername, credential: turnCredential });
    }

    try {
      const peer = new Peer({
        host: '0.peerjs.com',
        port: 443,
        secure: true,
        debug: 1,
        config: { iceServers, iceCandidatePoolSize: 10 },
      });

      peer.on('open', (id) => {
        myPeerIdRef.current = id;
        setConnectionStatus('Network Connected. Waiting for peer...');
        sendSystemMessage(`__SYS_PEER__:${id}`);
      });

      peer.on('call', (call) => {
        if (callStateRef.current !== 'idle') { 
          call.close(); 
          return; 
        }
        const type = (call.metadata?.type as 'voice' | 'video') || 'video';
        const callerId = call.metadata?.callerId || 'Unknown';
        setIncomingCallData({ call, type, callerId });
        setCallType(type);
        setCallState('incoming');
        playSound('call');

        if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current);
        callTimeoutRef.current = setTimeout(() => {
          if (callStateRef.current === 'incoming') declineCallRef.current();
        }, 30000);
      });

      peer.on('disconnected', () => {
        setConnectionStatus('Reconnecting...');
        setTimeout(() => {
          if (peer && !peer.destroyed) peer.reconnect();
        }, 2000);
      });

      peer.on('error', (err) => {
        console.warn('PeerJS notice:', err);
        setConnectionStatus('P2P standby');
      });

      peerInstance.current = peer;
    } catch (e) {
      console.warn('Peer initialization fallback:', e);
    }
  }, [sendSystemMessage]);

  const joinFromUrl = useCallback(() => {
    const { room: urlRoom, key: urlKey } = readRoomAndKeyFromLocation();
    if (urlRoom && urlKey) {
      setShowLanding(false);
      setRoomId(urlRoom);
      setSenderId(getOrCreateSenderId(urlRoom));
      importKeyFromBase64(urlKey)
        .then((key) => {
          setCryptoKey(key);
          setRoomKeyBase64(urlKey);
          setIsJoined(true);
          setConnectionStatus('Securing conversation...');
          setTimeout(() => initializePeer(), 300);
        })
        .catch((err) => {
          console.error('Key import failed', err);
          setCallError('Invalid secret key from link.');
        });
    }
  }, [initializePeer]);

  useEffect(() => {
    joinFromUrl();
    window.addEventListener('hashchange', joinFromUrl);
    return () => window.removeEventListener('hashchange', joinFromUrl);
  }, [joinFromUrl]);

  const createRoom = async () => {
    try {
      const newRoomId = generateRoomId();
      const key = await generateKey();
      const rawExportedKey = await exportKeyToBase64(key);
      const encodedKey = encodeURIComponent(rawExportedKey);

      setRoomId(newRoomId);
      setCryptoKey(key);
      setRoomKeyBase64(encodedKey);
      setSenderId(getOrCreateSenderId(newRoomId));
      setIsJoined(true);
      setShowLanding(false);
      setShowRoomDetails(true);
      window.history.pushState({}, '', `${window.location.pathname}#room=${newRoomId}&key=${encodedKey}`);
      setTimeout(() => initializePeer(), 300);
    } catch (err) {
      console.error('Failed to create room:', err);
      setCallError('Could not initialize room keys');
    }
  };

  const joinRoom = async () => {
    if (!joinRoomId.trim() || !joinRoomKey.trim()) {
      setCallError('Please enter both Room ID and Secret Key');
      return;
    }
    const normalizedRoomId = joinRoomId.trim().toUpperCase();
    try {
      const key = await importKeyFromBase64(joinRoomKey);
      setRoomId(normalizedRoomId);
      setCryptoKey(key);
      setRoomKeyBase64(joinRoomKey.trim());
      setSenderId(getOrCreateSenderId(normalizedRoomId));
      setIsJoined(true);
      setShowLanding(false);
      setConnectionStatus('Connected to Room');
      window.history.pushState({}, '', `${window.location.pathname}#room=${normalizedRoomId}&key=${encodeURIComponent(joinRoomKey.trim())}`);
      setTimeout(() => initializePeer(), 300);
    } catch (err) {
      setCallError('Invalid Secret Key. Please check and try again.');
      console.error('Key import failed', err);
    }
  };

  const leaveRoom = () => {
    if (currentCall.current) currentCall.current.close();
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    if (peerInstance.current) {
      peerInstance.current.destroy();
      peerInstance.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    myPeerIdRef.current = null;
    setRoomId(null);
    setCryptoKey(null);
    setRoomKeyBase64('');
    setIsJoined(false);
    setShowLanding(true);
    setShowRoomDetails(false);
    setShowCallMenu(false);
    setMessages([]);
    setRemotePeerId(null);
    setCallState('idle');
    decryptedCacheRef.current = {};
    window.history.pushState({}, '', window.location.pathname);
  };

  // --- POLLING ENGINE ---
  useEffect(() => {
    if (!isJoined || !roomId || !cryptoKey) return;
    let lastMessageCount = 0;

    const fetchMessages = async () => {
      try {
        const res = await fetch(`/api/message?roomId=${roomId}`);
        const data = await res.json();
        if (data.success && Array.isArray(data.messages)) {
          const processedMsgs = await Promise.all(
            data.messages.map(async (msg: any) => {
              if (msg.type === 'system') {
                let sysText = decryptedCacheRef.current[msg.id];
                if (!sysText) {
                  try {
                    sysText = await decryptText(msg.payload, cryptoKey);
                    decryptedCacheRef.current[msg.id] = sysText;
                  } catch {
                    return null;
                  }
                }

                if (sysText.startsWith('__SYS_PEER__:')) {
                  const pId = sysText.split('__SYS_PEER__:')[1];
                  if (pId !== myPeerIdRef.current) {
                    setRemotePeerId(pId);
                    setConnectionStatus('Peer Connected');
                    sendSystemMessage('__SYS_REQUEST_PROFILES__');
                  }
                  return null;
                }
                if (sysText === '__SYS_REQUEST_PROFILES__') {
                  if (profilePicRef.current) {
                    sendSystemMessage(`__SYS_PROFILE__::${senderId}::${profilePicRef.current}`);
                  }
                  return null;
                }
                if (sysText.startsWith('__SYS_PROFILE__::')) {
                  const payload = sysText.substring('__SYS_PROFILE__::'.length);
                  const firstColonIndex = payload.indexOf('::');
                  if (firstColonIndex !== -1) {
                    const pSender = payload.substring(0, firstColonIndex);
                    const pBase64 = payload.substring(firstColonIndex + 2);
                    setPeerProfiles((prev) => ({ ...prev, [pSender]: pBase64 }));
                  }
                  return null;
                }
                if (sysText === '__SYS_CALL_DECLINED__') {
                  setCallState('declined');
                  setTimeout(() => setCallState('idle'), 3000);
                  return null;
                }
                return null;
              }

              // Audio and Image types decrypt on demand
              if (msg.type === 'audio' || msg.type === 'image') {
                return msg;
              }

              // Text messages
              let text = decryptedCacheRef.current[msg.id];
              if (!text) {
                try {
                  text = await decryptText(msg.payload, cryptoKey);
                  decryptedCacheRef.current[msg.id] = text;
                } catch {
                  text = '[Encrypted message]';
                }
              }
              return { ...msg, text };
            })
          );

          const validMsgs = processedMsgs.filter((m) => m !== null);
          validMsgs.sort((a, b) => {
            const timeA = parseInt(a.id) || 0;
            const timeB = parseInt(b.id) || 0;
            return timeA - timeB;
          });

          if (validMsgs.length > lastMessageCount && lastMessageCount > 0) {
            playSound('receive');
          }
          lastMessageCount = validMsgs.length;
          setMessages(validMsgs);
        }
      } catch (err) { 
        console.error('Failed to fetch messages', err); 
      }
    };

    fetchMessages();
    intervalRef.current = setInterval(fetchMessages, 1200);
    return () => { 
      if (intervalRef.current) clearInterval(intervalRef.current); 
    };
  }, [isJoined, roomId, cryptoKey, senderId, sendSystemMessage]);

  const sendMessage = async () => {
    if (!inputText.trim() || !cryptoKey || !roomId) return;
    const messageId = `${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const currentInput = inputText.trim();
    setInputText('');
    try {
      const encryptedPayload = await encryptText(currentInput, cryptoKey);
      await fetch('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, messageId, encryptedPayload, senderId, type: 'text' }),
      });
      playSound('send');
    } catch (err) {
      console.error('Send message failed:', err);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCallError(`${label} copied to clipboard!`);
      setTimeout(() => setCallError(null), 2500);
    }
  };

  // --- VOICE NOTE FUNCTIONS ---
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioContext = new AudioCtx();
      audioContextRef.current = audioContext;
      const analyser = audioContext.createAnalyser();
      analyserRef.current = analyser;
      analyser.fftSize = 256;
      
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      
      const updateVisualizer = () => {
        if (!analyserRef.current) return;
        const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(dataArray);
        
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const average = sum / dataArray.length;
        const volume = Math.min(100, Math.max(0, (average / 255) * 100 * 2.5)); 
        
        setAudioLevel(volume);
        animationFrameRef.current = requestAnimationFrame(updateVisualizer);
      };
      updateVisualizer();

      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const options = mimeType ? { mimeType } : {};
      mediaRecorderRef.current = new MediaRecorder(stream, options);
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current.onstop = async () => {
        const recordedBlob = new Blob(audioChunksRef.current, { 
          type: mediaRecorderRef.current?.mimeType || 'audio/webm' 
        });
        if (recordedBlob.size > 0) {
          await sendVoiceNote(recordedBlob);
        }
        cleanupRecording();
      };

      mediaRecorderRef.current.start();
      setIsRecording(true);
      setRecordingTime(0);
      
      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime(prev => {
          if (prev >= 59) {
            stopRecording();
            return 60;
          }
          return prev + 1;
        });
      }, 1000);

    } catch (err: unknown) {
      console.error("Microphone access denied:", err);
      setCallError("Microphone access denied. Please allow microphone permissions.");
      setTimeout(() => setCallError(null), 3000);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setAudioLevel(0);
    }
  };

  const cancelRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setAudioLevel(0);
      audioChunksRef.current = [];
      cleanupRecording();
    }
  };

  const sendVoiceNote = async (audioBlob: Blob) => {
    if (!cryptoKey || !roomId) return;
    try {
      const reader = new FileReader();
      reader.readAsDataURL(audioBlob);
      reader.onloadend = async () => {
        const base64Audio = reader.result as string;
        const messageId = `${Date.now()}_aud_${Math.random().toString(36).substring(2, 6)}`;
        const encryptedPayload = await encryptText(base64Audio, cryptoKey);
        
        await fetch('/api/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomId, messageId, encryptedPayload, senderId, type: 'audio' }),
        });
        playSound('send');
      };
    } catch (error) {
      console.error("Voice note failed", error);
    }
  };

  const loadAudio = async (msgId: string, encryptedBase64: string) => {
    if (decryptedAudios[msgId] || !cryptoKey) return;
    try {
      const decryptedDataUrl = await decryptText(encryptedBase64, cryptoKey);
      setDecryptedAudios(prev => ({ ...prev, [msgId]: decryptedDataUrl }));
    } catch (error) {
      console.error("Audio decrypt failed", error);
    }
  };

  // --- CALL FUNCTIONS ---
  const startCall = async (type: 'voice' | 'video') => {
    if (!remotePeerId || !peerInstance.current) {
      setCallError('Waiting for peer to connect. Share the room link first!');
      setTimeout(() => setCallError(null), 3500);
      return;
    }
    if (callStateRef.current !== 'idle') return;

    setShowCallMenu(false);
    setCallType(type);
    setCallState('outgoing');
    setCallError(null);
    playSound('call');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: type === 'video', 
        audio: true 
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      const call = peerInstance.current.call(remotePeerId, stream, { 
        metadata: { type, callerId: senderId } 
      });
      currentCall.current = call;

      const pc = (call as any).peerConnection;
      if (pc) {
        pc.addEventListener('connectionstatechange', () => {
          setWebrtcConnectionState(pc.connectionState);
          if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            setCallError('Connection degraded. Reconnecting...');
          } else if (pc.connectionState === 'connected') {
            setCallError(null);
          }
        });
      }

      if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current);
      callTimeoutRef.current = setTimeout(() => {
        if (callStateRef.current === 'outgoing') {
          setCallError('Call timed out. No answer.');
          setCallState('failed');
          endCall();
        }
      }, 20000);

      call.on('stream', (remoteStream) => {
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
        setCallState('connected');
        if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current);
      });

      call.on('close', () => endCall());
      call.on('error', () => {
        setCallError('Call failed. Please try again.');
        setCallState('failed');
        endCall();
      });
    } catch (err: any) {
      setCallError(`Media blocked: ${err?.message || 'Check permissions'}`);
      endCall();
    }
  };

  const acceptCall = async () => {
    if (!incomingCallData) return;
    const { call, type } = incomingCallData;
    setCallType(type);
    setCallError(null);

    if (callTimeoutRef.current) { 
      clearTimeout(callTimeoutRef.current); 
      callTimeoutRef.current = null; 
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: type === 'video', 
        audio: true 
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      call.answer(stream);
      currentCall.current = call;

      const pc = (call as any).peerConnection;
      if (pc) {
        pc.addEventListener('connectionstatechange', () => {
          setWebrtcConnectionState(pc.connectionState);
          if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            setCallError('Connection degraded. Reconnecting...');
          } else if (pc.connectionState === 'connected') {
            setCallError(null);
          }
        });
      }

      call.on('stream', (remoteStream) => {
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
        setCallState('connected');
      });
      call.on('close', () => endCall());
      call.on('error', () => {
        setCallError('Call failed.');
        setCallState('failed');
        endCall();
      });

      setIncomingCallData(null);
    } catch (err: any) {
      setCallError(`Media blocked: ${err?.message || 'Check permissions'}`);
      declineCall();
    }
  };

  const declineCall = useCallback(() => {
    if (callTimeoutRef.current) { 
      clearTimeout(callTimeoutRef.current); 
      callTimeoutRef.current = null; 
    }
    if (incomingCallData) {
      incomingCallData.call.close();
      sendSystemMessage('__SYS_CALL_DECLINED__');
      setIncomingCallData(null);
    }
    setCallState('idle');
    setCallError(null);
  }, [incomingCallData, sendSystemMessage]);

  useEffect(() => {
    declineCallRef.current = declineCall;
  }, [declineCall]);

  const endCall = () => {
    if (callTimeoutRef.current) { 
      clearTimeout(callTimeoutRef.current); 
      callTimeoutRef.current = null; 
    }
    if (currentCall.current) { 
      currentCall.current.close(); 
      currentCall.current = null; 
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;

    setCallState('idle');
    setIncomingCallData(null);
    setIsMuted(false);
    setIsVideoOff(false);
    setCallError(null);
    setWebrtcConnectionState('new');
  };

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const audioTracks = localStreamRef.current.getAudioTracks();
    const nextMuted = !isMuted;
    audioTracks.forEach((track) => { track.enabled = !nextMuted; });
    setIsMuted(nextMuted);
  }, [isMuted]);

  const toggleVideo = useCallback(() => {
    if (!localStreamRef.current) return;
    const videoTracks = localStreamRef.current.getVideoTracks();
    const nextOff = !isVideoOff;
    videoTracks.forEach((track) => { track.enabled = !nextOff; });
    setIsVideoOff(nextOff);
  }, [isVideoOff]);

  const compressImage = (file: File, maxW: number, quality: number): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = (event) => {
        const img = new window.Image();
        img.src = event.target?.result as string;
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let w = img.width, h = img.height;
          if (w > maxW) { h = Math.round((h * maxW) / w); w = maxW; }
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) return reject(new Error('Canvas failed'));
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
      };
      reader.onerror = reject;
    });
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !cryptoKey || !roomId) return;
    try {
      const compressed = await compressImage(file, 800, 0.6);
      const messageId = `${Date.now()}_img_${Math.random().toString(36).substring(2, 6)}`;
      const encryptedPayload = await encryptText(compressed, cryptoKey);
      await fetch('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, messageId, encryptedPayload, senderId, type: 'image' }),
      });
      playSound('send');
    } catch (error) { 
      console.error('Image upload failed', error); 
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleProfileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressImage(file, 100, 0.5);
      setProfilePic(compressed);
      saveProfileToStorage(compressed);
      if (cryptoKey && roomId) {
        await sendSystemMessage(`__SYS_PROFILE__::${senderId}::${compressed}`);
      }
    } catch (error) { 
      console.error('Profile upload failed', error); 
    }
    if (profileInputRef.current) profileInputRef.current.value = '';
  };

  const removeProfilePic = () => {
    setProfilePic('');
    clearProfileFromStorage();
  };

  const openImage = async (msgId: string, encryptedBase64: string) => {
    if (!cryptoKey || viewedImages.has(msgId)) return;
    try {
      const decryptedDataUrl = await decryptText(encryptedBase64, cryptoKey);
      setViewingImage({ url: decryptedDataUrl, id: msgId });
    } catch (error) { 
      console.error('Decrypt failed', error); 
    }
  };

  const closeImageViewer = () => {
    if (viewingImage) {
      const id = viewingImage.id;
      setViewedImages((prev) => new Set(prev).add(id));
      setViewingImage(null);
      if (roomId) {
        fetch(`/api/message?roomId=${roomId}&messageId=${id}`, { method: 'DELETE' }).catch(() => {});
      }
    }
  };

  const handleTouch = (e: React.MouseEvent | React.TouchEvent) => {
    const touch = 'touches' in e ? e.touches[0] : e;
    if (!touch) return;
    const ripple = document.createElement('div');
    ripple.className = 'fixed w-24 h-24 bg-indigo-500/20 rounded-full pointer-events-none animate-ping z-50';
    ripple.style.left = `${touch.clientX - 48}px`;
    ripple.style.top = `${touch.clientY - 48}px`;
    document.body.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  };

  // --- INITIAL LOADING SCREEN ---
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex flex-col items-center justify-center p-4" onClick={handleTouch}>
        <div className="relative">
          <div className="absolute inset-0 bg-indigo-500 rounded-full animate-ping opacity-20"></div>
          <div className="relative w-28 h-28 bg-white/10 backdrop-blur-xl rounded-3xl flex items-center justify-center border border-white/20 shadow-2xl">
            <Lock className="w-14 h-14 text-indigo-400 animate-pulse" />
          </div>
        </div>
        <div className="mt-8 text-center">
          <h2 className="text-2xl font-bold text-white mb-2 tracking-wider font-sans">SECRET CHAT</h2>
          <div className="flex items-center justify-center space-x-2 text-indigo-300">
            <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
            <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
            <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
          </div>
          <p className="text-gray-400 text-xs mt-3 font-sans">Loading encrypted vault...</p>
        </div>
      </div>
    );
  }

  // --- LANDING PAGE ---
  if (showLanding) {
    return (
      <div 
        className={`min-h-screen bg-cover bg-center bg-fixed transition-opacity duration-500 ${showContent ? 'opacity-100' : 'opacity-0'}`} 
        style={{ backgroundImage: "url('/images/bg-pattern.png')" }} 
        onClick={handleTouch}
      >
        <div className="min-h-screen bg-slate-950/90 backdrop-blur-md flex flex-col">
          {/* Header */}
          <div className={`bg-white/10 backdrop-blur-xl shadow-lg p-4 flex items-center justify-between transition-all duration-500 ${showContent ? 'translate-y-0 opacity-100' : '-translate-y-10 opacity-0'}`}>
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg">
                <Lock className="w-5 h-5 text-white" />
              </div>
              <h1 className="text-lg font-bold text-white font-sans tracking-tight">SECRET CHAT</h1>
            </div>
            <div className="flex items-center space-x-1.5 text-emerald-400 bg-emerald-950/40 border border-emerald-800/40 px-2.5 py-1 rounded-full text-[10px]">
              <ShieldCheck size={13} />
              <span>Zero Knowledge E2E</span>
            </div>
          </div>

          {callError && (
            <div className="mx-auto mt-4 max-w-sm bg-red-500/90 text-white text-[11px] px-4 py-2 rounded-xl flex items-center space-x-2 shadow-lg">
              <AlertCircle size={14} />
              <span>{callError}</span>
            </div>
          )}

          {/* Main Card */}
          <div className="flex-1 flex flex-col items-center justify-center p-6 space-y-6">
            <div className={`text-center space-y-3 transition-all duration-500 ${showContent ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0'}`}>
              <div className="w-24 h-24 mx-auto bg-gradient-to-br from-indigo-500 to-purple-600 rounded-3xl flex items-center justify-center shadow-2xl">
                <Lock className="w-12 h-12 text-white" />
              </div>
              <h2 className="text-2xl font-bold text-white font-sans">Private, Ephemeral Messaging</h2>
              <p className="text-gray-400 text-xs max-w-sm mx-auto font-sans leading-relaxed">
                End-to-end encrypted rooms with voice notes, peer-to-peer audio/video calling, and self-destructing media.
              </p>
            </div>

            <div className={`w-full max-w-xs space-y-4 transition-all duration-500 ${showContent ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0'}`}>
              <button 
                onClick={createRoom} 
                className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-semibold py-3 px-5 rounded-xl shadow-lg transition-all transform hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center space-x-2 text-sm cursor-pointer"
              >
                <MessageCircle size={17} />
                <span>Create Secret Room</span>
              </button>

              <div className="relative">
                <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-gray-800"></div></div>
                <div className="relative flex justify-center text-xs"><span className="px-3 bg-slate-950 text-gray-500 uppercase tracking-widest font-mono text-[9px]">or join existing</span></div>
              </div>

              <div className="bg-white/5 backdrop-blur-xl p-4 rounded-xl shadow-md border border-gray-800 space-y-3">
                <p className="text-[11px] font-medium text-gray-300 text-center font-sans">Join With Room Credentials</p>
                <input 
                  type="text" 
                  placeholder="Room ID (e.g. 7K2Q4MN9)" 
                  value={joinRoomId} 
                  onChange={(e) => setJoinRoomId(e.target.value)} 
                  className="w-full px-3 py-2 bg-slate-900/60 border border-gray-700 rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-xs text-white placeholder-gray-500 uppercase" 
                />
                <input 
                  type="text" 
                  placeholder="Secret Key (base64 string)" 
                  value={joinRoomKey} 
                  onChange={(e) => setJoinRoomKey(e.target.value)} 
                  className="w-full px-3 py-2 bg-slate-900/60 border border-gray-700 rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none text-xs text-white placeholder-gray-500 font-mono" 
                />
                <button 
                  onClick={joinRoom} 
                  className="w-full bg-slate-800 hover:bg-slate-700 text-white font-semibold py-2.5 px-4 rounded-lg transition-all flex items-center justify-center space-x-1.5 text-xs cursor-pointer"
                >
                  <Lock size={13} />
                  <span>Join Room</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- ROOM DETAILS MODAL ---
  if (showRoomDetails && roomId && cryptoKey) {
    const roomUrl = roomId && roomKeyBase64 ? buildShareUrl(roomId, roomKeyBase64) : '';
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex items-center justify-center p-4" onClick={handleTouch}>
        <div className="bg-slate-900/95 backdrop-blur-xl border border-gray-800 rounded-2xl p-6 max-w-sm w-full space-y-4 shadow-2xl">
          <div className="text-center">
            <div className="w-14 h-14 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-full flex items-center justify-center mx-auto mb-3 shadow-lg">
              <Lock className="w-7 h-7 text-white" />
            </div>
            <h3 className="text-lg font-bold text-white font-sans">Secret Room Created</h3>
            <p className="text-gray-400 text-xs mt-1 font-sans">Share this link with your peer to talk securely</p>
          </div>

          <div className="space-y-2.5">
            <div className="bg-slate-950/70 p-3 rounded-lg border border-gray-800">
              <p className="text-[10px] text-gray-500 mb-0.5 font-sans">Room ID</p>
              <div className="flex items-center justify-between">
                <p className="text-indigo-400 font-mono text-sm font-bold tracking-wider">{roomId}</p>
                <button onClick={() => copyToClipboard(roomId, 'Room ID')} className="text-gray-400 hover:text-white p-1" title="Copy Room ID">
                  <Copy size={15} />
                </button>
              </div>
            </div>

            <div className="bg-slate-950/70 p-3 rounded-lg border border-gray-800">
              <p className="text-[10px] text-gray-500 mb-0.5 font-sans">Direct Invitation Link</p>
              <div className="flex items-center justify-between">
                <p className="text-gray-300 text-[11px] truncate max-w-[200px] font-mono">{roomUrl}</p>
                <button onClick={() => copyToClipboard(roomUrl, 'Invitation Link')} className="text-indigo-400 hover:text-indigo-300 flex items-center space-x-1 p-1" title="Copy Link">
                  <Share2 size={15} />
                </button>
              </div>
            </div>
          </div>

          <button 
            onClick={() => setShowRoomDetails(false)} 
            className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-semibold py-3 rounded-xl transition-all text-xs cursor-pointer shadow-lg"
          >
            Enter Encrypted Vault
          </button>
        </div>
      </div>
    );
  }

  // --- INCOMING CALL MODAL ---
  if (callState === 'incoming' && incomingCallData) {
    return (
      <div className="fixed inset-0 z-50 bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex flex-col items-center justify-between py-20 px-4" onClick={handleTouch}>
        <div className="flex flex-col items-center space-y-5">
          <div className="w-28 h-28 rounded-full bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center overflow-hidden border-4 border-white/20 shadow-2xl animate-pulse">
            {peerProfiles[incomingCallData.callerId] ? (
              <img src={peerProfiles[incomingCallData.callerId]} className="w-full h-full object-cover" alt="Caller" />
            ) : (
              <User size={56} className="text-white" />
            )}
          </div>
          <div className="text-center">
            <h2 className="text-xl font-bold text-white font-sans">{incomingCallData.callerId}</h2>
            <p className="text-indigo-300 text-xs mt-1 font-sans animate-pulse">
              Incoming {incomingCallData.type === 'video' ? 'Video' : 'Voice'} Call...
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-14 pb-8">
          <button onClick={declineCall} className="flex flex-col items-center space-y-2 cursor-pointer group">
            <div className="w-16 h-16 rounded-full bg-red-600 flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
              <PhoneOff size={26} className="text-white" />
            </div>
            <span className="text-white text-xs font-sans">Decline</span>
          </button>
          <button onClick={acceptCall} className="flex flex-col items-center space-y-2 cursor-pointer group">
            <div className="w-16 h-16 rounded-full bg-emerald-600 flex items-center justify-center shadow-lg animate-bounce group-hover:scale-110 transition-transform">
              <Phone size={26} className="text-white" />
            </div>
            <span className="text-white text-xs font-sans">Answer</span>
          </button>
        </div>
      </div>
    );
  }

  // --- ACTIVE CALL OVERLAY ---
  if (callState === 'outgoing' || callState === 'connected' || callState === 'declined' || callState === 'failed') {
    return (
      <div className="fixed inset-0 z-50 bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-950 flex flex-col" onClick={handleTouch}>
        {callError && (
          <div className="absolute top-6 left-1/2 -translate-x-1/2 bg-red-500/90 text-white text-xs px-4 py-2 rounded-full flex items-center space-x-2 shadow-lg z-50">
            <AlertCircle size={14} />
            <span>{callError}</span>
          </div>
        )}
        <div className="relative flex-1 flex items-center justify-center">
          {callType === 'video' && callState === 'connected' ? (
            <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
          ) : (
            <div className="flex flex-col items-center space-y-5">
              <div className="w-36 h-36 rounded-full bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center overflow-hidden border-4 border-white/20 shadow-2xl">
                {remotePeerId && peerProfiles[remotePeerId] ? (
                  <img src={peerProfiles[remotePeerId]} className="w-full h-full object-cover" alt="Remote user" />
                ) : (
                  <User size={64} className="text-white" />
                )}
              </div>
              <div className="text-center">
                <h2 className="text-lg font-bold text-white font-sans">
                  {callState === 'outgoing' ? 'Calling...' : callState === 'declined' ? 'Call Declined' : callState === 'failed' ? 'Call Ended' : 'Call Connected'}
                </h2>
                <p className="text-gray-400 text-xs mt-1 font-sans">{callType === 'video' ? 'Video' : 'Voice'} Call</p>
                {webrtcConnectionState === 'checking' && <p className="text-indigo-400 text-[11px] mt-1 animate-pulse">Tunneling...</p>}
              </div>
            </div>
          )}
          {(callType === 'video' || !isVideoOff) && callState === 'connected' && (
            <video ref={localVideoRef} autoPlay playsInline muted className="absolute bottom-24 right-4 w-28 h-36 object-cover border-2 border-indigo-500/50 rounded-2xl bg-black shadow-2xl" />
          )}
        </div>

        {callState !== 'declined' && callState !== 'failed' && (
          <div className="bg-slate-950/90 backdrop-blur-xl p-6 flex flex-col items-center border-t border-gray-800 space-y-4">
            <div className="flex items-center space-x-8">
              <button onClick={toggleMute} className="flex flex-col items-center space-y-1 cursor-pointer">
                <div className={`w-12 h-12 rounded-full ${isMuted ? 'bg-white' : 'bg-slate-800'} flex items-center justify-center transition-all`}>
                  {isMuted ? <MicOff size={20} className="text-slate-900" /> : <Mic size={20} className="text-white" />}
                </div>
                <span className="text-[10px] text-gray-400 font-sans">{isMuted ? 'Unmute' : 'Mute'}</span>
              </button>

              {callType === 'video' && (
                <button onClick={toggleVideo} className="flex flex-col items-center space-y-1 cursor-pointer">
                  <div className={`w-12 h-12 rounded-full ${isVideoOff ? 'bg-white' : 'bg-slate-800'} flex items-center justify-center transition-all`}>
                    {isVideoOff ? <VideoOff size={20} className="text-slate-900" /> : <Video size={20} className="text-white" />}
                  </div>
                  <span className="text-[10px] text-gray-400 font-sans">{isVideoOff ? 'Cam Off' : 'Cam On'}</span>
                </button>
              )}

              <button onClick={endCall} className="flex flex-col items-center space-y-1 cursor-pointer">
                <div className="w-14 h-14 rounded-full bg-red-600 flex items-center justify-center shadow-lg hover:bg-red-700 transition-colors">
                  <PhoneOff size={24} className="text-white" />
                </div>
                <span className="text-[10px] text-gray-400 font-sans">End</span>
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // --- MAIN CHAT INTERFACE ---
  return (
    <div className="flex flex-col h-screen bg-cover bg-center bg-fixed text-gray-200 overflow-hidden relative" style={{ backgroundImage: "url('/images/bg-pattern.png')" }} onClick={handleTouch}>
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-950/40 via-purple-950/40 to-slate-950/40" style={{ background: `linear-gradient(${animationPhase}deg, rgba(99, 102, 241, 0.25) 0%, rgba(168, 85, 247, 0.25) 50%, rgba(15, 23, 42, 0.4) 100%)` }}></div>
      </div>

      {callError && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 bg-slate-900/95 border border-indigo-500/40 text-indigo-300 text-xs px-4 py-2 rounded-full shadow-2xl z-40 flex items-center space-x-2">
          <Info size={14} className="text-indigo-400" />
          <span>{callError}</span>
        </div>
      )}

      {/* Header */}
      <header className="relative bg-slate-950/90 backdrop-blur-xl p-3 flex justify-between items-center border-b border-gray-800 shrink-0 z-10">
        <div className="flex items-center space-x-3">
          <div 
            className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center overflow-hidden cursor-pointer hover:ring-2 hover:ring-indigo-500 transition-all shrink-0" 
            onClick={() => profileInputRef.current?.click()}
            title="Click to set avatar"
          >
            {profilePic ? (
              <img src={profilePic} className="w-full h-full object-cover" alt="Profile" />
            ) : (
              <User size={16} className="text-white" />
            )}
          </div>
          <input type="file" ref={profileInputRef} onChange={handleProfileUpload} accept="image/*" className="hidden" />
          
          <div>
            <div className="flex items-center space-x-1.5">
              <h1 className="text-white font-bold text-xs font-sans tracking-wide">SECRET ROOM</h1>
              <span className="text-[9px] bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 px-1.5 py-0.5 rounded font-mono font-bold">
                {roomId}
              </span>
            </div>
            <p className="text-[10px] text-gray-400 flex items-center font-sans mt-0.5">
              <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${remotePeerId ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`}></span>
              {remotePeerId ? 'Peer connected' : connectionStatus}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-1">
          <button 
            onClick={() => startCall('voice')} 
            className="p-2 rounded-full hover:bg-slate-800 text-gray-300 hover:text-white transition-colors cursor-pointer"
            title="Voice Call"
          >
            <Phone size={17} />
          </button>
          <button 
            onClick={() => startCall('video')} 
            className="p-2 rounded-full hover:bg-slate-800 text-gray-300 hover:text-white transition-colors cursor-pointer"
            title="Video Call"
          >
            <Video size={17} />
          </button>

          <div className="relative" ref={callMenuRef}>
            <button 
              onClick={() => setShowCallMenu(!showCallMenu)} 
              className="p-2 rounded-full hover:bg-slate-800 text-gray-300 hover:text-white transition-colors cursor-pointer"
            >
              <MoreVertical size={18} />
            </button>
            {showCallMenu && (
              <div className="absolute right-0 top-11 bg-slate-900/95 backdrop-blur-xl border border-gray-800 rounded-xl shadow-2xl py-1.5 w-48 z-50">
                <button 
                  onClick={() => { setShowRoomDetails(true); setShowCallMenu(false); }} 
                  className="w-full flex items-center space-x-2 px-3 py-2 hover:bg-slate-800 text-xs text-gray-200 cursor-pointer"
                >
                  <Share2 size={14} className="text-indigo-400" />
                  <span>Room Details & Share</span>
                </button>
                <button 
                  onClick={() => { copyToClipboard(roomId || '', 'Room ID'); setShowCallMenu(false); }} 
                  className="w-full flex items-center space-x-2 px-3 py-2 hover:bg-slate-800 text-xs text-gray-200 cursor-pointer"
                >
                  <Copy size={14} className="text-indigo-400" />
                  <span>Copy Room ID</span>
                </button>
                {profilePic && (
                  <button 
                    onClick={() => { removeProfilePic(); setShowCallMenu(false); }} 
                    className="w-full flex items-center space-x-2 px-3 py-2 hover:bg-slate-800 text-xs text-gray-200 cursor-pointer"
                  >
                    <User size={14} className="text-indigo-400" />
                    <span>Remove Profile Photo</span>
                  </button>
                )}
                <div className="border-t border-gray-800 my-1"></div>
                <button 
                  onClick={leaveRoom} 
                  className="w-full flex items-center space-x-2 px-3 py-2 hover:bg-red-500/20 text-xs text-red-400 cursor-pointer"
                >
                  <LogOut size={14} />
                  <span>Leave Room</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Messages */}
      <main className="relative flex-1 overflow-y-auto p-4 space-y-3 z-10">
        {messages.length === 0 && (
          <div className="text-center text-gray-400 mt-20 space-y-2">
            <div className="w-12 h-12 bg-slate-800/80 rounded-2xl flex items-center justify-center mx-auto mb-2 border border-gray-700/50">
              <Lock className="w-6 h-6 text-indigo-400" />
            </div>
            <p className="text-sm font-semibold text-gray-300 font-sans">The vault is secure and ready.</p>
            <p className="text-xs text-gray-500 font-sans max-w-xs mx-auto">
              Share the room details to invite someone. Messages self-destruct after 5 minutes.
            </p>
            <button 
              onClick={() => setShowRoomDetails(true)} 
              className="mt-2 inline-flex items-center space-x-1.5 text-xs text-indigo-400 bg-indigo-950/60 hover:bg-indigo-900/60 border border-indigo-800/60 px-3 py-1.5 rounded-full transition-colors cursor-pointer"
            >
              <Share2 size={12} />
              <span>Invite via Link</span>
            </button>
          </div>
        )}

        {messages.map((msg) => {
          const isMe = msg.sender === senderId;
          const avatar = isMe ? profilePic : peerProfiles[msg.sender];
          return (
            <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'} items-end space-x-2`}>
              {!isMe && (
                <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-600 to-purple-600 flex-shrink-0 overflow-hidden">
                  {avatar ? (
                    <img src={avatar} className="w-full h-full object-cover" alt={msg.sender} />
                  ) : (
                    <User size={12} className="text-white m-auto mt-1.5" />
                  )}
                </div>
              )}
              
              <div className={`max-w-[78%] p-3 rounded-2xl ${isMe ? 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-tr-sm shadow-md' : 'bg-slate-800/90 text-gray-200 border border-gray-700/60 rounded-tl-sm backdrop-blur-sm'}`}>
                {!isMe && <p className="text-[10px] text-indigo-300 font-bold mb-1 font-mono">{msg.sender}</p>}
                
                {msg.type === 'audio' ? (
                  <div className="flex flex-col space-y-1 bg-black/30 p-2 rounded-xl min-w-[210px]">
                    {decryptedAudios[msg.id] ? (
                      <audio controls src={decryptedAudios[msg.id]} className="w-full h-8" />
                    ) : (
                      <button 
                        onClick={() => loadAudio(msg.id, msg.payload)} 
                        className="flex items-center space-x-2 text-xs text-indigo-300 hover:text-white w-full justify-center py-2 transition-colors cursor-pointer"
                      >
                        <Mic size={14} className="text-indigo-400 animate-pulse" />
                        <span>Tap to decrypt voice note</span>
                      </button>
                    )}
                  </div>
                ) : msg.type === 'image' ? (
                  viewedImages.has(msg.id) ? (
                    <div className="flex items-center space-x-1.5 text-xs bg-black/30 p-2 rounded-xl text-gray-400">
                      <ImageIcon size={14} />
                      <span>Photo opened and destroyed</span>
                    </div>
                  ) : (
                    <button 
                      onClick={() => openImage(msg.id, msg.payload)} 
                      className="flex items-center space-x-2 text-xs bg-black/40 hover:bg-black/60 p-2.5 rounded-xl w-full text-left transition-colors cursor-pointer border border-white/10"
                    >
                      <ImageIcon size={15} className="text-indigo-400" />
                      <span>{isMe ? 'Sent View-Once Photo' : 'View Once Photo (Burn After Reading)'}</span>
                    </button>
                  )
                ) : (
                  <p className="break-words text-xs leading-relaxed font-sans select-text">{msg.text}</p>
                )}
              </div>

              {isMe && (
                <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-600 to-purple-600 flex-shrink-0 overflow-hidden">
                  {avatar ? (
                    <img src={avatar} className="w-full h-full object-cover" alt="You" />
                  ) : (
                    <User size={12} className="text-white m-auto mt-1.5" />
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </main>

      {/* Footer Controls */}
      <footer className="relative bg-slate-950/90 backdrop-blur-xl p-2.5 flex items-center border-t border-gray-800 shrink-0 z-10">
        {isRecording ? (
          <div className="flex-1 flex items-center justify-between bg-slate-900/90 rounded-full px-4 py-2 border border-red-500/40">
            <button 
              onClick={cancelRecording} 
              className="text-gray-400 hover:text-red-400 p-2 transition-colors cursor-pointer"
              title="Cancel Recording"
            >
              <X size={20} />
            </button>
            
            <div className="flex flex-col items-center flex-1 mx-2">
              <span className="text-red-400 text-xs font-mono mb-1">
                {Math.floor(recordingTime / 60).toString().padStart(2, '0')}:
                {(recordingTime % 60).toString().padStart(2, '0')}
              </span>
              <AudioVisualizer level={audioLevel} />
            </div>

            <button 
              onClick={stopRecording} 
              className="text-gray-400 hover:text-green-400 p-2 transition-colors cursor-pointer"
              title="Send Voice Note"
            >
              <Check size={24} className="text-emerald-500" strokeWidth={3} />
            </button>
          </div>
        ) : (
          <>
            <input type="file" ref={fileInputRef} onChange={handleImageUpload} accept="image/*" className="hidden" />
            <button 
              onClick={() => fileInputRef.current?.click()} 
              className="text-gray-400 hover:text-white p-2 transition-colors cursor-pointer" 
              title="Send View-Once Photo"
            >
              <ImageIcon size={20} />
            </button>
            <button 
              onClick={startRecording} 
              className="text-gray-400 hover:text-indigo-400 p-2 transition-colors cursor-pointer" 
              title="Record Voice Note"
            >
              <Mic size={20} />
            </button>
            <input 
              type="text" 
              value={inputText} 
              onChange={(e) => setInputText(e.target.value)} 
              onKeyDown={(e) => e.key === 'Enter' && sendMessage()} 
              placeholder="Type encrypted message..." 
              className="flex-1 bg-slate-900/80 text-white text-xs p-2.5 rounded-full outline-none focus:ring-1 focus:ring-indigo-500 font-sans placeholder-gray-500 mx-2" 
            />
            <button 
              onClick={sendMessage} 
              className="bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white p-2.5 rounded-full transition-all cursor-pointer shadow-md"
              title="Send"
            >
              <Send size={16} />
            </button>
          </>
        )}
      </footer>

      {/* Burn-After-Reading Image Viewer */}
      {viewingImage && (
        <div 
          className="fixed inset-0 bg-black/95 z-50 flex flex-col items-center justify-center p-4 select-none backdrop-blur-xl cursor-pointer" 
          onClick={closeImageViewer}
        >
          <img 
            src={viewingImage.url} 
            alt="View once confidential" 
            className="max-w-full max-h-[85vh] object-contain pointer-events-none rounded-lg shadow-2xl" 
            onContextMenu={(e) => e.preventDefault()} 
            draggable={false} 
          />
          <p className="absolute bottom-10 text-rose-400 text-xs tracking-widest animate-pulse font-sans font-semibold">
            TAP ANYWHERE TO CLOSE & DESTROY
          </p>
        </div>
      )}
    </div>
  );
}
