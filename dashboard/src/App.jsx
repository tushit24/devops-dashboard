import React, { useState, useEffect, useRef } from 'react';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend, 
  ResponsiveContainer 
} from 'recharts';
import { 
  Activity, 
  Info, 
  AlertTriangle, 
  XOctagon, 
  PlusCircle, 
  RefreshCw,
  Terminal,
  Database,
  Layers,
  HeartHandshake
} from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

function App() {
  const [stats, setStats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [systemStatus, setSystemStatus] = useState('connecting');
  const [recentLocalEvents, setRecentLocalEvents] = useState([]);
  
  // Custom message input states
  const [customMsg, setCustomMsg] = useState('');
  const [customType, setCustomType] = useState('info');
  const [submitting, setSubmitting] = useState(false);

  // References for notification timeouts
  const pollingRef = useRef(null);

  // Fetch metrics from API
  const fetchStats = async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      const response = await fetch(`${API_URL}/stats`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      setStats(data);
      setSystemStatus('online');
      setError(null);
    } catch (err) {
      console.error('Error fetching statistics:', err);
      setSystemStatus('offline');
      setError('Could not connect to the Ingestion API. Ensure it is running.');
    } finally {
      if (isInitial) setLoading(false);
    }
  };

  // Poll for stats every 5 seconds
  useEffect(() => {
    fetchStats(true);
    
    pollingRef.current = setInterval(() => {
      fetchStats(false);
    }, 5000);

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  // Calculate Aggregates
  const totals = stats.reduce(
    (acc, curr) => {
      const count = parseInt(curr.count) || 0;
      if (curr.event_type === 'info') acc.info += count;
      if (curr.event_type === 'warning') acc.warning += count;
      if (curr.event_type === 'error') acc.error += count;
      return acc;
    },
    { info: 0, warning: 0, error: 0 }
  );

  // Format statistics for Recharts
  const getChartData = () => {
    const grouped = {};
    stats.forEach(item => {
      const date = new Date(item.minute);
      // Format time as HH:MM
      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      
      if (!grouped[item.minute]) {
        grouped[item.minute] = {
          minute: item.minute,
          displayTime: timeStr,
          info: 0,
          warning: 0,
          error: 0
        };
      }
      grouped[item.minute][item.event_type] = parseInt(item.count);
    });

    return Object.values(grouped).sort((a, b) => new Date(a.minute) - new Date(b.minute));
  };

  // Submit event to API
  const handleSendEvent = async (type, message) => {
    if (!message.trim()) return;
    setSubmitting(true);
    try {
      const response = await fetch(`${API_URL}/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type, message })
      });
      
      if (!response.ok) {
        throw new Error(`Submit failed with code ${response.status}`);
      }

      const resData = await response.json();
      
      // Update local feed
      const newLocalEvent = {
        id: Date.now() + Math.random(),
        type,
        message,
        timestamp: new Date().toLocaleTimeString(),
        status: 'Enqueued'
      };
      setRecentLocalEvents(prev => [newLocalEvent, ...prev].slice(0, 10));
      
      // Clear message field if custom
      setCustomMsg('');

      // Instantly trigger a background stats refresh
      fetchStats(false);
    } catch (err) {
      console.error('Failed to trigger event:', err);
      alert(`Error submitting event: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCustomSubmit = (e) => {
    e.preventDefault();
    handleSendEvent(customType, customMsg);
  };

  const chartData = getChartData();

  return (
    <div className="app-container">
      {/* Header Panel */}
      <header>
        <div className="logo-section">
          <h1>⚡ DEVOPS ANALYTICS</h1>
          <p>Real-time log ingestion and aggregation dashboard</p>
        </div>
        <div className="header-meta" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <button onClick={() => fetchStats(false)} style={{ background: 'rgba(255,255,255,0.05)', boxShadow: 'none', border: '1px solid rgba(255,255,255,0.1)', padding: '0.5rem' }}>
            <RefreshCw size={16} />
          </button>
          <div className={`status-badge ${systemStatus === 'online' ? 'polling' : ''}`} style={{ 
            background: systemStatus === 'online' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
            borderColor: systemStatus === 'online' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
            color: systemStatus === 'online' ? '#10b981' : '#ef4444'
          }}>
            <div className="pulse-dot" style={{ backgroundColor: systemStatus === 'online' ? '#10b981' : '#ef4444', boxShadow: systemStatus === 'online' ? '0 0 8px #10b981' : '0 0 8px #ef4444' }} />
            <span>API: {systemStatus.toUpperCase()}</span>
          </div>
        </div>
      </header>

      {/* Summary Cards */}
      <div className="stats-summary-bar">
        <div className="stat-card info">
          <div className="stat-info">
            <h4>Info Events</h4>
            <div className="stat-value">{totals.info}</div>
          </div>
          <div className="stat-icon">
            <Info size={28} />
          </div>
        </div>
        <div className="stat-card warning">
          <div className="stat-info">
            <h4>Warning Events</h4>
            <div className="stat-value">{totals.warning}</div>
          </div>
          <div className="stat-icon">
            <AlertTriangle size={28} />
          </div>
        </div>
        <div className="stat-card error">
          <div className="stat-info">
            <h4>Error Events</h4>
            <div className="stat-value">{totals.error}</div>
          </div>
          <div className="stat-icon">
            <XOctagon size={28} />
          </div>
        </div>
        <div className="stat-card" style={{ borderLeft: '4px solid var(--primary)' }}>
          <div className="stat-info">
            <h4>Total Aggregated</h4>
            <div className="stat-value">{totals.info + totals.warning + totals.error}</div>
          </div>
          <div className="stat-icon" style={{ background: 'var(--primary-glow)', color: 'var(--primary-hover)' }}>
            <Layers size={28} />
          </div>
        </div>
      </div>

      {/* Main Grid Section */}
      <div className="dashboard-grid">
        
        {/* Left Column: Visual Analytics */}
        <div className="card" style={{ minHeight: '400px' }}>
          <div className="card-title">
            <Activity size={20} className="text-primary" />
            <span>Event Aggregates Per Minute (Last 30 Min)</span>
          </div>
          
          {loading ? (
            <div className="empty-state">
              <RefreshCw className="animate-spin" size={24} style={{ animation: 'pulse-dot 1.5s infinite ease-in-out' }} />
              <p style={{ marginTop: '1rem' }}>Loading live aggregates...</p>
            </div>
          ) : error ? (
            <div className="empty-state" style={{ color: 'var(--accent-error)' }}>
              <XOctagon size={32} />
              <p style={{ marginTop: '1rem' }}>{error}</p>
            </div>
          ) : chartData.length === 0 ? (
            <div className="empty-state">
              <Database size={32} />
              <p style={{ marginTop: '1rem' }}>No events recorded yet. Send some simulated events to populate the queue!</p>
            </div>
          ) : (
            <div style={{ width: '100%', height: 320 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis 
                    dataKey="displayTime" 
                    stroke="var(--text-secondary)"
                    fontSize={12}
                    tickLine={false}
                  />
                  <YAxis 
                    stroke="var(--text-secondary)"
                    fontSize={12}
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'rgba(17, 24, 39, 0.95)', 
                      borderColor: 'rgba(255, 255, 255, 0.1)',
                      borderRadius: '8px',
                      color: 'var(--text-primary)'
                    }} 
                  />
                  <Legend iconType="circle" />
                  <Bar dataKey="info" name="Info" fill="var(--accent-info)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="warning" name="Warning" fill="var(--accent-warning)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="error" name="Error" fill="var(--accent-error)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Right Column: Interaction Panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          
          {/* Quick Fire Simulator */}
          <div className="card">
            <div className="card-title">
              <PlusCircle size={20} />
              <span>Simulated Event Generator</span>
            </div>
            
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Click to fire quick events and watch them stream through Redis into Postgres:
            </p>
            
            <div className="btn-group">
              <button 
                className="btn-info" 
                onClick={() => handleSendEvent('info', 'Microservice health check passed')}
                disabled={submitting}
              >
                + Info
              </button>
              <button 
                className="btn-warning" 
                onClick={() => handleSendEvent('warning', 'DB pool size exceeded 80%')}
                disabled={submitting}
              >
                + Warning
              </button>
              <button 
                className="btn-error" 
                onClick={() => handleSendEvent('error', 'Auth token decryption failed')}
                disabled={submitting}
              >
                + Error
              </button>
            </div>

            <hr style={{ border: 'none', borderTop: '1px solid rgba(255, 255, 255, 0.05)' }} />

            {/* Custom Event Form */}
            <form onSubmit={handleCustomSubmit} className="custom-event-form">
              <div className="form-group">
                <label>Event Type</label>
                <select 
                  value={customType} 
                  onChange={(e) => setCustomType(e.target.value)}
                  disabled={submitting}
                >
                  <option value="info">Info</option>
                  <option value="warning">Warning</option>
                  <option value="error">Error</option>
                </select>
              </div>
              
              <div className="form-group">
                <label>Log Message</label>
                <input 
                  type="text" 
                  value={customMsg}
                  onChange={(e) => setCustomMsg(e.target.value)}
                  placeholder="Enter a custom message..."
                  required
                  disabled={submitting}
                />
              </div>

              <button type="submit" disabled={submitting || !customMsg.trim()}>
                {submitting ? 'Queuing event...' : 'Publish Event'}
              </button>
            </form>
          </div>
        </div>

      </div>

      {/* Footer Area: Local activity list */}
      <div className="card">
        <div className="card-title">
          <Terminal size={20} />
          <span>Local Session Ingestion Feed (Recent logs published)</span>
        </div>
        
        {recentLocalEvents.length === 0 ? (
          <div className="empty-state" style={{ padding: '1rem 0' }}>
            No events submitted in this browser session.
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Level</th>
                  <th>Message</th>
                  <th>Ingestion Status</th>
                </tr>
              </thead>
              <tbody>
                {recentLocalEvents.map((evt) => (
                  <tr key={evt.id}>
                    <td style={{ color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{evt.timestamp}</td>
                    <td>
                      <span className={`badge ${evt.type}`}>{evt.type}</span>
                    </td>
                    <td>{evt.message}</td>
                    <td style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#10b981' }}>
                      <HeartHandshake size={14} />
                      <span>{evt.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
