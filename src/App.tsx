import { useState, useEffect, useRef } from 'react';
import { Mic, Bell, Activity, Settings, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

declare global {
  interface Window {
    electron: {
      sendNotification: (title: string, body: string) => void;
      showWindow: () => void;
      exportLogs: (logs: any[]) => void;
    };
  }
}

const DB_METER_KEY = 'db-meter-settings';

interface SoundEvent {
  id: string;
  timestamp: string;
  db: number;
  label: string;
}

const getDbLabel = (db: number) => {
  if (db < 30) return 'Whisper Quiet';
  if (db < 40) return 'Quiet Library';
  if (db < 50) return 'Quiet Room';
  if (db < 60) return 'Normal Conversation';
  if (db < 70) return 'Busy Office';
  if (db < 80) return 'Loud Café';
  if (db < 90) return 'Vacuum / Traffic';
  if (db < 100) return 'Sound System';
  return 'Potential Damage!';
};

function CircularMeter({ value, threshold, isAlerting }: { value: number; threshold: number; isAlerting: boolean }) {
  const size = 320;
  const stroke = 12;
  const radius = (size / 2) - (stroke * 2);
  const circumference = radius * 2 * Math.PI;
  // Map 0-120dB to 0-100% of circle
  const percentage = Math.min(100, Math.max(0, (value / 120) * 100));
  const offset = circumference - (percentage / 100) * circumference;
  const thresholdPercentage = (threshold / 120) * 100;

  return (
    <div className="meter-container">
      {/* Glow Layer */}
      <div style={{
        position: 'absolute', inset: 0, borderRadius: '50%',
        background: isAlerting ? 'radial-gradient(circle, rgba(244,63,94,0.15) 0%, transparent 70%)' : 'radial-gradient(circle, rgba(56,189,248,0.1) 0%, transparent 70%)',
        zIndex: 0
      }} />

      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)', zIndex: 1 }}>
        {/* Background Track */}
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth={stroke}
        />
        {/* Threshold Marker */}
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke="var(--danger)" strokeWidth={stroke + 2}
          strokeDasharray={`${2} ${circumference / 100 * 1 - 2}`}
          strokeDashoffset={-(circumference * (thresholdPercentage / 100))}
          style={{ opacity: 0.5 }}
        />
        {/* Progress Bar */}
        <motion.circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke={isAlerting ? 'var(--danger)' : 'url(#meterGradient)'} strokeWidth={stroke}
          strokeDasharray={circumference}
          animate={{ strokeDashoffset: offset }}
          transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
          strokeLinecap="round"
        />
        <defs>
          <linearGradient id="meterGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="var(--accent-purple)" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}

export default function App() {
  const [displayDb, setDisplayDb] = useState(0);
  const [peak, setPeak] = useState(0);
  const [history, setHistory] = useState<number[]>(new Array(100).fill(0));
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>('');
  const [threshold, setThreshold] = useState(80);
  const [durationThreshold, setDurationThreshold] = useState(2); // New: seconds required
  const [isAlerting, setIsAlerting] = useState(false);
  const [frequencies, setFrequencies] = useState<number[]>(new Array(40).fill(0));
  const [events, setEvents] = useState<SoundEvent[]>([]);
  const [sessionHistory, setSessionHistory] = useState<number[]>([]);
  const [trendView, setTrendView] = useState<'live' | 'session'>('live');
  const [calibrationOffset, setCalibrationOffset] = useState(0);
  const [smoothingSpeed, setSmoothingSpeed] = useState<'slow' | 'medium' | 'fast'>('medium');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const audioContext = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastNotifyTime = useRef<number>(0);
  const thresholdRef = useRef(80);
  const smoothedDbRef = useRef(0);
  const durationRef = useRef(2);
  const loudStartTimeRef = useRef<number | null>(null);
  const calibrationRef = useRef(0);
  const smoothingAlphaRef = useRef(0.25);
  const displayIntervalRef = useRef(700);
  const lastDisplayUpdateRef = useRef(0);
  const sessionPeakRef = useRef(0);
  const eventPeakRef = useRef(0);
  const isEventOccurring = useRef(false);

  useEffect(() => {
    const saved = localStorage.getItem(DB_METER_KEY);
    if (saved) {
      const { threshold, deviceId, durationThreshold, calibrationOffset, smoothingSpeed } = JSON.parse(saved);
      if (threshold) {
        setThreshold(threshold);
        thresholdRef.current = threshold;
      }
      if (durationThreshold) {
        setDurationThreshold(durationThreshold);
        durationRef.current = durationThreshold;
      }
      if (calibrationOffset !== undefined) {
        setCalibrationOffset(calibrationOffset);
        calibrationRef.current = calibrationOffset;
      }
      if (smoothingSpeed) {
        setSmoothingSpeed(smoothingSpeed);
        const alphas = { slow: 0.1, medium: 0.25, fast: 0.6 };
        const intervals = { slow: 1000, medium: 700, fast: 400 };
        smoothingAlphaRef.current = alphas[smoothingSpeed as 'slow' | 'medium' | 'fast'] || 0.25;
        displayIntervalRef.current = intervals[smoothingSpeed as 'slow' | 'medium' | 'fast'] || 700;
      }
      if (deviceId) setSelectedDevice(deviceId);
    }

    navigator.mediaDevices.enumerateDevices().then(items => {
      const mics = items.filter(d => d.kind === 'audioinput');
      setDevices(mics);
      if (mics.length > 0 && !selectedDevice) {
        setSelectedDevice(mics[0].deviceId);
      }
    });
  }, []);

  useEffect(() => {
    localStorage.setItem(DB_METER_KEY, JSON.stringify({
      threshold,
      deviceId: selectedDevice,
      durationThreshold,
      calibrationOffset,
      smoothingSpeed
    }));
    thresholdRef.current = threshold;
    durationRef.current = durationThreshold;
    calibrationRef.current = calibrationOffset;

    const alphas = { slow: 0.1, medium: 0.25, fast: 0.6 };
    const intervals = { slow: 1000, medium: 700, fast: 400 };
    smoothingAlphaRef.current = alphas[smoothingSpeed] || 0.25;
    displayIntervalRef.current = intervals[smoothingSpeed] || 700;
  }, [threshold, selectedDevice, durationThreshold, calibrationOffset, smoothingSpeed]);

  useEffect(() => {
    if (!selectedDevice) return;
    startMonitoring(selectedDevice);
    return () => {
      stopMonitoring();
      setPeak(0);
      setHistory(new Array(100).fill(0));
    };
  }, [selectedDevice]);

  useEffect(() => {
    // Session aggregator: Every 30 seconds, push the max peak of that period
    const interval = setInterval(() => {
      setSessionHistory(prev => {
        const newHistory = [...prev, sessionPeakRef.current];
        // Keep last 480 points (480 * 30s = 4 hours)
        return newHistory.slice(-480);
      });
      sessionPeakRef.current = 0;
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  const startMonitoring = async (deviceId: string) => {
    stopMonitoring();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          noiseSuppression: false,
          echoCancellation: false,
          autoGainControl: false
        }
      });
      streamRef.current = stream;

      audioContext.current = new AudioContext();
      const source = audioContext.current.createMediaStreamSource(stream);

      analyser.current = audioContext.current.createAnalyser();
      analyser.current.fftSize = 1024;
      source.connect(analyser.current);

      const bufferLength = analyser.current.frequencyBinCount;
      const dataArray = new Float32Array(bufferLength);
      const freqArray = new Uint8Array(bufferLength);

      const update = () => {
        if (!analyser.current) return;
        const now = Date.now();
        analyser.current.getFloatTimeDomainData(dataArray);
        analyser.current.getByteFrequencyData(freqArray);

        // Calculate RMS using 32-bit float samples (more precise than 8-bit)
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / bufferLength);

        // Convert to dB with a recalibrated base offset (+80dB)
        // This is the "sweet spot" identified after testing with -15dB offset.
        const baseDb = rms > 0.000001 ? 20 * Math.log10(rms) + 80 : 0;
        const currentDb = Math.round(Math.max(0, baseDb + calibrationRef.current));

        // Exponential Moving Average for background smoothing (high frequency)
        const alpha = smoothingAlphaRef.current;
        smoothedDbRef.current = (alpha * currentDb) + (1 - alpha) * smoothedDbRef.current;

        // Throttled UI Display Update
        if (now - lastDisplayUpdateRef.current > displayIntervalRef.current) {
          setDisplayDb(smoothedDbRef.current);
          lastDisplayUpdateRef.current = now;
        }

        // Visualizer data (using freqArray for visual dance)
        const visualData = Array.from(freqArray.slice(0, 40)).map(v => v / 255);
        setFrequencies(visualData);

        // Update Peaks
        setPeak(prev => Math.max(prev, currentDb));
        sessionPeakRef.current = Math.max(sessionPeakRef.current, currentDb);

        // Update History (throttle updates to state)
        if (now % 3 === 0) { // Update history roughly every 50ms
          setHistory(prev => [...prev.slice(1), currentDb]);
        }

        // Threshold check and Event Tracking
        const currentThreshold = thresholdRef.current;
        const currentDurationLimit = durationRef.current;

        if (currentDb > currentThreshold) {
          setIsAlerting(true);

          if (!loudStartTimeRef.current) {
            loudStartTimeRef.current = Date.now();
          }

          const sustainedDuration = (Date.now() - loudStartTimeRef.current) / 1000;

          // Track peak for the current loud event
          eventPeakRef.current = Math.max(eventPeakRef.current, currentDb);

          // Only start event if sustained long enough
          if (!isEventOccurring.current && sustainedDuration >= currentDurationLimit && (now - lastNotifyTime.current > 7000)) {
            isEventOccurring.current = true;

            // Wait 1 second more to capture the absolute highest peak
            setTimeout(() => {
              const peakToSend = eventPeakRef.current;
              console.log('Sending SUSTAINED peak notification...', { eventPeak: peakToSend, threshold: currentThreshold, duration: sustainedDuration });
              window.electron.sendNotification(
                'Sustained Noise Detected!',
                `Level reached ${peakToSend} dB for ${currentDurationLimit}+ sec.`
              );

              setEvents(prev => [{
                id: Math.random().toString(36).substr(2, 9),
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                db: peakToSend,
                label: getDbLabel(peakToSend)
              }, ...prev].slice(0, 50)); // Increased to 50 events

              lastNotifyTime.current = Date.now();
              isEventOccurring.current = false;
              eventPeakRef.current = 0;
            }, 1000);
          }
        } else {
          setIsAlerting(false);
          loudStartTimeRef.current = null;
        }

        requestAnimationFrame(update);
      };

      update();
    } catch (err) {
      console.error('Audio error:', err);
    }
  };

  const stopMonitoring = async () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (audioContext.current && audioContext.current.state !== 'closed') {
      try {
        await audioContext.current.close();
      } catch (e) {
        console.warn('Silent error closing AudioContext:', e);
      } finally {
        audioContext.current = null;
      }
    }
  };

  return (
    <div className="app-root">
      <div className="bg-mesh" />
      <div className="bg-overlay" />

      <div className="title-bar" style={{ justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Activity size={12} style={{ marginRight: 8, color: 'var(--accent)' }} />
          dB Meter Pro
        </div>

        {/* Mobile Menu Toggle */}
        <button
          className="btn-premium"
          style={{ padding: '4px 8px', height: 26, fontSize: 10, border: 'none', background: isMobileMenuOpen ? 'var(--accent)' : 'rgba(255,255,255,0.05)', color: isMobileMenuOpen ? '#000' : '#fff' }}
          onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        >
          {isMobileMenuOpen ? <X size={14} /> : <Settings size={14} />}
          <span style={{ marginLeft: 6 }}>{isMobileMenuOpen ? 'CLOSE' : 'SETTINGS'}</span>
        </button>
      </div>

      <main className="app-layout">
        {/* LEFT SIDE: Controls */}
        <aside className={`area-side-left ${!isMobileMenuOpen ? 'mobile-hidden' : ''}`}>
          <div className="glass control-item">
            <div className="label"><Mic size={14} /> Device Selection</div>
            <select value={selectedDevice} onChange={(e) => setSelectedDevice(e.target.value)}>
              {devices.map(d => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || `Mic ${d.deviceId.slice(0, 5)}`}</option>
              ))}
            </select>
          </div>

          <div className="glass" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <div className="label" style={{ marginBottom: 4 }}>Current Peak</div>
              <div style={{ fontSize: 24, fontWeight: '900', color: 'var(--accent)', letterSpacing: -1 }}>{peak} <span style={{ fontSize: 10, opacity: 0.5 }}>dB</span></div>
            </div>
            <button className="btn-premium" style={{ height: 40 }} onClick={() => setPeak(0)}>RESET</button>
          </div>

          <div className="glass control-item">
            <div className="label"><Bell size={14} /> Notification Threshold ({threshold} dB)</div>
            <input type="range" min="30" max="110" value={threshold} onChange={(e) => setThreshold(parseInt(e.target.value))} />
            <div style={{ fontSize: 9, opacity: 0.6, textAlign: 'center', letterSpacing: 1 }}>{getDbLabel(threshold).toUpperCase()}</div>
          </div>

          <div className="glass control-item">
            <div className="label"><Activity size={14} /> Smoothing Speed</div>
            <div style={{ display: 'flex', gap: 4, background: 'rgba(0,0,0,0.3)', padding: 4, borderRadius: 12 }}>
              {(['slow', 'medium', 'fast'] as const).map(speed => (
                <button
                  key={speed}
                  onClick={() => setSmoothingSpeed(speed)}
                  className="btn-premium"
                  style={{
                    flex: 1,
                    border: 'none',
                    background: smoothingSpeed === speed ? 'var(--accent)' : 'transparent',
                    color: smoothingSpeed === speed ? '#000' : 'inherit',
                    padding: '6px 0',
                    fontSize: 9
                  }}
                >
                  {speed.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="glass control-item">
            <div className="label"><Activity size={14} /> Manual Calibration ({calibrationOffset > 0 ? '+' : ''}{calibrationOffset} dB)</div>
            <input type="range" min="-30" max="30" value={calibrationOffset} onChange={(e) => setCalibrationOffset(parseInt(e.target.value))} />
          </div>
        </aside>

        {/* CENTER: Main Meter */}
        <section className="area-center">
          <div className="meter-container">
            <CircularMeter value={displayDb} threshold={threshold} isAlerting={isAlerting} />
            <div style={{ position: 'absolute', pointerEvents: 'none' }}>
              <motion.div className="db-display">
                <div className="db-value">{displayDb.toFixed(1)}</div>
                <div className="db-unit">Decibels</div>
              </motion.div>
            </div>
          </div>

          <div style={{ marginTop: -10, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            <AnimatePresence mode="wait">
              <motion.div
                key={getDbLabel(Math.round(displayDb))}
                initial={{ opacity: 0, y: 10, filter: 'blur(10px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -10, filter: 'blur(10px)' }}
                style={{ fontSize: 13, fontWeight: '900', letterSpacing: 3, textTransform: 'uppercase', color: isAlerting ? 'var(--danger)' : 'var(--accent)' }}
              >
                {getDbLabel(Math.round(displayDb))}
              </motion.div>
            </AnimatePresence>

            <div className="alert-indicator">
              <div className={`status-dot ${isAlerting ? 'active' : ''}`} />
              {isAlerting ? 'THRESHOLD EXCEEDED' : 'SIGNAL STABLE'}
            </div>
          </div>

          <div className="visualizer-mini" style={{ width: '100%', maxWidth: 280, marginTop: 30 }}>
            {frequencies.map((v, i) => (
              <div key={i} className="v-bar" style={{ height: `${Math.max(10, v * 100)}%`, opacity: 0.15 + (v * 0.85), background: isAlerting ? 'var(--danger)' : 'var(--accent)' }} />
            ))}
          </div>
        </section>

        {/* RIGHT SIDE: History */}
        <aside className={`area-side-right ${!isMobileMenuOpen ? 'mobile-hidden' : ''}`}>
          <div className="glass" style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 22 }}>
            <div className="label" style={{ marginBottom: 14, justifyContent: 'space-between' }}>
              <span>Trend History</span>
              <div style={{ display: 'flex', gap: 4, background: 'rgba(0,0,0,0.2)', padding: 2, borderRadius: 8 }}>
                <button onClick={() => setTrendView('live')} style={{ fontSize: 8, padding: '2px 6px', borderRadius: 6, cursor: 'pointer', border: 'none', background: trendView === 'live' ? 'var(--accent)' : 'transparent', color: trendView === 'live' ? '#000' : '#fff' }}>LIVE</button>
                <button onClick={() => setTrendView('session')} style={{ fontSize: 8, padding: '2px 6px', borderRadius: 6, cursor: 'pointer', border: 'none', background: trendView === 'session' ? 'var(--accent)' : 'transparent', color: trendView === 'session' ? '#000' : '#fff' }}>SESSION</button>
              </div>
            </div>

            <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 1, background: 'rgba(0,0,0,0.3)', borderRadius: 16, padding: 10, minHeight: 140 }}>
              {(trendView === 'live' ? history : sessionHistory).map((h, i) => (
                <div key={i} style={{ flex: 1, height: `${(h / 120) * 100}%`, background: h > threshold ? 'var(--danger)' : 'var(--accent)', opacity: 0.2 + (h / 120) * 0.8, borderRadius: 2 }} />
              ))}
            </div>

            <div className="label" style={{ marginTop: 24, marginBottom: 14, justifyContent: 'space-between' }}>
              <span>Recent Activity</span>
              {events.length > 0 && <span style={{ cursor: 'pointer', color: 'var(--accent)', fontSize: 9 }} onClick={() => window.electron.exportLogs(events)}>EXPORT</span>}
            </div>

            <div className="custom-scrollbar" style={{ flex: 2, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {events.length === 0 ? (
                <div style={{ padding: 30, textAlign: 'center', opacity: 0.2, fontSize: 11, fontStyle: 'italic' }}>No alerts recorded</div>
              ) : (
                events.map(e => (
                  <div key={e.id} className="glass" style={{ padding: '12px 14px', borderLeft: '4px solid var(--danger)', borderRadius: 14, background: 'rgba(244,63,94,0.03)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontSize: 9, opacity: 0.5, letterSpacing: 1 }}>{e.timestamp}</span>
                      <span style={{ fontSize: 12, fontWeight: '900', color: 'var(--danger)' }}>{e.db} dB</span>
                    </div>
                    <div style={{ fontSize: 11, fontWeight: '800', color: 'var(--text-primary)' }}>{e.label.toUpperCase()}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
