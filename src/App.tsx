import { useState, useEffect, useRef } from 'react';
import { Mic, Bell, Activity } from 'lucide-react';
import { motion } from 'framer-motion';

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
  return 'Potential Hearing Damage!';
};

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
  const [showLogs, setShowLogs] = useState(false);
  const [calibrationOffset, setCalibrationOffset] = useState(0);
  const [smoothingSpeed, setSmoothingSpeed] = useState<'slow' | 'medium' | 'fast'>('medium');

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
    <div className="app-container">
      <div className="title-bar">
        <Activity size={16} className="mr-2" style={{ marginRight: 8 }} />
        dB Meter Pro
      </div>

      <motion.div
        className="main-card glass"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div style={{ position: 'absolute', top: 20, right: 20, display: 'flex', alignItems: 'center' }}>
          <div className={`alert-dot ${isAlerting ? 'active' : ''}`} />
          <span className="label" style={{ color: isAlerting ? 'var(--danger)' : 'var(--text-secondary)' }}>
            {isAlerting ? 'THRESHOLD EXCEEDED' : 'LIVE MONITORING'}
          </span>
        </div>

        <motion.span
          className="db-value"
          animate={{ scale: isAlerting ? [1, 1.02, 1] : 1 }}
          transition={{ duration: 0.1 }}
        >
          {displayDb.toFixed(1)}
        </motion.span>
        <span className="db-unit">DECIBELS</span>

        <motion.div
          key={getDbLabel(Math.round(displayDb))}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          style={{ marginTop: 8, color: isAlerting ? 'var(--danger)' : 'var(--text-secondary)', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1, fontSize: 13 }}
        >
          {getDbLabel(Math.round(displayDb))}
        </motion.div>

        <div style={{ marginTop: 24, display: 'flex', gap: 16 }}>
          <div className="glass" style={{ padding: '8px 16px', textAlign: 'center', minWidth: 140 }}>
            <div className="label" style={{ fontSize: 10 }}>Peak Level</div>
            <div style={{ fontSize: 24, fontWeight: '800', color: 'var(--accent)' }}>{peak}</div>
            <div style={{ fontSize: 9, opacity: 0.6, marginTop: 2, textTransform: 'uppercase' }}>{getDbLabel(peak)}</div>
          </div>
          <button
            className="glass"
            style={{ padding: '8px 16px', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: '600', transition: 'all 0.2s', border: '1px solid rgba(255,255,255,0.1)' }}
            onClick={() => setPeak(0)}
          >
            Reset Peak
          </button>
          <button
            className="glass"
            style={{ padding: '8px 16px', color: showLogs ? 'var(--accent)' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: '600', transition: 'all 0.2s', border: '1px solid rgba(255,255,255,0.1)' }}
            onClick={() => setShowLogs(!showLogs)}
          >
            {showLogs ? 'Hide Logs' : 'View Logs'} ({events.length})
          </button>
        </div>

        <div style={{ marginTop: 40, width: '100%', minHeight: 120 }}>
          <div className="label" style={{ marginBottom: 12, opacity: 0.6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{trendView === 'live' ? 'Live Activity (5s)' : 'Session Trend (4h max)'}</span>
            <div className="glass" style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', padding: 2 }}>
              <button
                onClick={() => setTrendView('live')}
                style={{ background: trendView === 'live' ? 'rgba(56, 189, 248, 0.2)' : 'transparent', border: 'none', color: trendView === 'live' ? 'var(--accent)' : 'var(--text-secondary)', padding: '2px 8px', fontSize: 10, cursor: 'pointer', transition: 'all 0.2s', borderRadius: 6 }}
              >
                LIVE
              </button>
              <button
                onClick={() => setTrendView('session')}
                style={{ background: trendView === 'session' ? 'rgba(56, 189, 248, 0.2)' : 'transparent', border: 'none', color: trendView === 'session' ? 'var(--accent)' : 'var(--text-secondary)', padding: '2px 8px', fontSize: 10, cursor: 'pointer', transition: 'all 0.2s', borderRadius: 6 }}
              >
                SESSION
              </button>
            </div>
          </div>
          <div className="glass" style={{ width: '100%', height: 70, display: 'flex', alignItems: 'flex-end', gap: 1, padding: '4px' }}>
            {trendView === 'live' ? (
              history.map((h, i) => (
                <div
                  key={i}
                  style={{
                    flex: 1,
                    height: `${Math.max(4, (h / 120) * 100)}%`,
                    background: h > threshold ? 'var(--danger)' : 'var(--accent)',
                    opacity: 0.3 + (h / 120) * 0.7,
                    borderRadius: 1,
                    transition: 'height 0.1s ease'
                  }}
                />
              ))
            ) : (
              sessionHistory.length === 0 ? (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, opacity: 0.4 }}>
                  Collecting session data... (updates every 30s)
                </div>
              ) : (
                sessionHistory.map((h, i) => (
                  <div
                    key={i}
                    style={{
                      flex: 1,
                      height: `${Math.max(4, (h / 120) * 100)}%`,
                      background: h > threshold ? 'var(--danger)' : 'var(--accent)',
                      opacity: 0.3 + (h / 120) * 0.7,
                      borderRadius: 1,
                    }}
                  />
                ))
              )
            )}
          </div>
        </div>

        {showLogs && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            style={{ marginTop: 40, width: '100%' }}
          >
            <div className="label" style={{ marginBottom: 12, opacity: 0.6, display: 'flex', justifyContent: 'space-between' }}>
              <span>Recent Noise Events</span>
              <div style={{ display: 'flex', gap: 12 }}>
                {events.length > 0 && <span style={{ cursor: 'pointer', color: 'var(--accent)' }} onClick={() => window.electron.exportLogs(events)}>Export CSV</span>}
                {events.length > 0 && <span style={{ cursor: 'pointer', color: 'var(--accent)' }} onClick={() => setEvents([])}>Clear History</span>}
              </div>
            </div>
            <div className="custom-scrollbar" style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 300, overflowY: 'auto', paddingRight: 4 }}>
              {events.length === 0 ? (
                <div className="glass" style={{ padding: '20px', textAlign: 'center', opacity: 0.4, fontSize: 13 }}>
                  No significant noise events recorded yet.
                </div>
              ) : (
                events.map((event) => (
                  <motion.div
                    key={event.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="glass"
                    style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderLeft: '3px solid var(--danger)' }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontSize: 10, opacity: 0.5, marginBottom: 2 }}>{event.timestamp}</span>
                      <span style={{ fontWeight: '600', fontSize: 14 }}>{event.label}</span>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontSize: 18, fontWeight: '800', color: 'var(--danger)' }}>{event.db}</span>
                      <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 4 }}>dB</span>
                    </div>
                  </motion.div>
                ))
              )}
            </div>
          </motion.div>
        )}

        <div className="visualizer-container" style={{ gap: 4 }}>
          {frequencies.map((v, i) => (
            <div
              key={i}
              className="bar"
              style={{
                height: `${Math.max(4, v * 100)}%`,
                background: isAlerting ? 'var(--danger)' : 'var(--accent)',
                opacity: 0.2 + (v * 0.8),
                borderRadius: '4px'
              }}
            />
          ))}
        </div>
      </motion.div>

      <div className="controls">
        <div className="control-item glass">
          <div className="label">
            <Mic size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Microphone Selection
          </div>
          <select
            value={selectedDevice}
            onChange={(e) => setSelectedDevice(e.target.value)}
          >
            {devices.map(d => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${d.deviceId.slice(0, 5)}`}</option>
            ))}
          </select>
        </div>

        <div className="control-item glass">
          <div className="label">
            <Bell size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Notification Threshold ({threshold} dB - {getDbLabel(threshold)})
          </div>
          <input
            type="range"
            min="30"
            max="120"
            value={threshold}
            onChange={(e) => setThreshold(parseInt(e.target.value))}
          />
        </div>

        <div className="control-item glass">
          <div className="label">
            <Activity size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Duration Filter ({durationThreshold.toFixed(1)}s)
          </div>
          <input
            type="range"
            min="0.1"
            max="10"
            step="0.1"
            value={durationThreshold}
            onChange={(e) => setDurationThreshold(parseFloat(e.target.value))}
          />
        </div>

        <div className="control-item glass">
          <div className="label">
            <Activity size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Smoothing Speed
          </div>
          <div className="glass" style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', padding: 2, marginTop: 8 }}>
            {(['slow', 'medium', 'fast'] as const).map(speed => (
              <button
                key={speed}
                onClick={() => setSmoothingSpeed(speed)}
                style={{
                  flex: 1,
                  background: smoothingSpeed === speed ? 'var(--accent)' : 'transparent',
                  border: 'none',
                  color: smoothingSpeed === speed ? '#fff' : 'var(--text-secondary)',
                  padding: '6px 4px',
                  fontSize: 10,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  borderRadius: 6,
                  fontWeight: '600',
                  textTransform: 'uppercase'
                }}
              >
                {speed}
              </button>
            ))}
          </div>
        </div>

        <div className="control-item glass">
          <div className="label">
            <Activity size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Manual Calibration ({calibrationOffset > 0 ? '+' : ''}{calibrationOffset} dB)
          </div>
          <input
            type="range"
            min="-30"
            max="30"
            step="1"
            value={calibrationOffset}
            onChange={(e) => setCalibrationOffset(parseInt(e.target.value))}
          />
          <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>
            Compare with a phone app and use this slider to align the readings.
          </div>
        </div>
      </div>
    </div>
  );
}
