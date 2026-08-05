"use client";

import { useEffect, useState } from "react";
import { initializeApp, getApps } from "firebase/app";
import { getFirestore, collection, query, orderBy, limit, getDocs } from "firebase/firestore";
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler } from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

// Ambil konfigurasi langsung dari .env.local
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};
const app = !getApps().length ? initializeApp(firebaseConfig) : getApps()[0];
const db = getFirestore(app);

// Ambil kapasitas nominal & nama collection dari environment variable Next.js
const MASTER_CAPACITY_AH = parseFloat(process.env.NEXT_PUBLIC_MASTER_CAPACITY_AH || "200");
const SLAVE_CAPACITY_AH = parseFloat(process.env.NEXT_PUBLIC_SLAVE_CAPACITY_AH || "100");
const FIRESTORE_COLLECTION = process.env.NEXT_PUBLIC_FIRESTORE_COLLECTION || "bms_logs_test";

export default function Dashboard() {
  const [data, setData] = useState<any>(null);
  const [powerChartData, setPowerChartData] = useState<any>({ labels: [], datasets: [] });
  const [socChartData, setSocChartData] = useState<any>({ labels: [], datasets: [] });
  const [loading, setLoading] = useState(true);

  // State untuk Modal Kalibrasi
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [apiSecret, setApiSecret] = useState("");
  const [masterTargetAh, setMasterTargetAh] = useState("");
  const [slaveTargetAh, setSlaveTargetAh] = useState("");
  const [correcting, setCorrecting] = useState(false);
  const [correctMessage, setCorrectMessage] = useState("");

  // Load API_SECRET dari localStorage saat pertama kali buka
  useEffect(() => {
    const savedSecret = localStorage.getItem("bms_api_secret");
    if (savedSecret) {
      setApiSecret(savedSecret);
    }
  }, []);

  const fetchData = async () => {
    try {
      const q = query(collection(db, FIRESTORE_COLLECTION), orderBy("timestamp", "desc"), limit(300));
      const querySnapshot = await getDocs(q);

      let docs: any[] = [];
      querySnapshot.forEach((doc) => {
        docs.push(doc.data());
      });

      if (docs.length > 0) {
        setData(docs[0]);

        const reversed = [...docs].reverse();
        const labels = reversed.map(d => new Date(d.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

        const masterSoc = reversed.map(d => d.master?.soc ?? 0);
        const slaveSoc = reversed.map(d => d.slave?.soc ?? 0);

        const pvProduction = reversed.map(d => d.system?.totalPpv || 0);
        const loadConsumption = reversed.map(d => d.system?.loadPower || 0);
        const gridPower = reversed.map(d => d.system?.gridPower || 0); // Ambil dari field system.gridPower

        // 1. Grafik Gabungan Power (PV, Load, Grid dalam 1 Skala Watt)
        setPowerChartData({
          labels,
          datasets: [
            {
              label: 'PV Production (W)',
              data: pvProduction,
              borderColor: '#fbbf24',
              backgroundColor: 'rgba(251, 191, 36, 0.05)',
              borderWidth: 2,
              fill: false,
              tension: 0.3,
              pointRadius: 0,          // <-- Titik bulatan disembunyikan
              pointHoverRadius: 4,     // <-- Bulatan muncul pas di-hover
            },
            {
              label: 'Load Consumption (W)',
              data: loadConsumption,
              borderColor: '#38bdf8',
              backgroundColor: 'rgba(56, 189, 248, 0.05)',
              borderWidth: 2,
              fill: false,
              tension: 0.3,
              pointRadius: 0,
              pointHoverRadius: 4,
            },
            {
              label: 'Grid Power (W)',
              data: gridPower,
              borderColor: '#f43f5e',
              backgroundColor: 'rgba(244, 63, 94, 0.05)',
              borderWidth: 2,
              fill: false,
              tension: 0.3,
              pointRadius: 0,
              pointHoverRadius: 4,
            }
          ]
        });

        // 2. Grafik Khusus Perbandingan SOC (Master vs Slave)
        setSocChartData({
          labels,
          datasets: [
            {
              label: 'Master SOC (%)',
              data: masterSoc,
              borderColor: '#60a5fa',
              backgroundColor: 'rgba(96, 165, 250, 0.1)',
              borderWidth: 2,
              fill: true,
              tension: 0.3,
              pointRadius: 0,
              pointHoverRadius: 4,
            },
            {
              label: 'Slave SOC (%)',
              data: slaveSoc,
              borderColor: '#c084fc',
              backgroundColor: 'rgba(192, 132, 252, 0.1)',
              borderWidth: 2,
              fill: true,
              tension: 0.3,
              pointRadius: 0,
              pointHoverRadius: 4,
            }
          ]
        });
      }
      setLoading(false);
    } catch (err) {
      console.error("Gagal ambil data Firestore:", err);
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  // Handler untuk Trigger API Correct
  const handleCorrectionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCorrecting(true);
    setCorrectMessage("");

    localStorage.setItem("bms_api_secret", apiSecret);

    try {
      const response = await fetch('/api/growatt/correct', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiSecret}`
        },
        body: JSON.stringify({
          masterAh: masterTargetAh ? parseFloat(masterTargetAh) : undefined,
          slaveAh: slaveTargetAh ? parseFloat(slaveTargetAh) : undefined,
        })
      });

      const result = await response.json();

      if (response.ok) {
        setCorrectMessage("✅ Kalibrasi Ah berhasil dikirim!");
        setTimeout(() => {
          setIsModalOpen(false);
          setCorrectMessage("");
          fetchData();
        }, 1500);
      } else {
        setCorrectMessage(`❌ Gagal: ${result.error || 'Unauthorized / Error sistem'}`);
      }
    } catch (err) {
      console.error("Error API Correct:", err);
      setCorrectMessage("❌ Terjadi kesalahan jaringan.");
    } finally {
      setCorrecting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <p className="text-emerald-400 font-mono animate-pulse">Memuat Data BMS...</p>
      </div>
    );
  }

  const master = data?.master || {};
  const slave = data?.slave || {};
  const system = data?.system || {};

  const isCharging = system.totalPower > 0;
  const isDischarging = system.totalPower < 0;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-6">

        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center border-b border-slate-800 pb-4 gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-emerald-400">⚡ {data?.plantName || "BMS Monitor"}</h1>
            <p className="text-xs text-slate-400 font-mono">Device SN: {data?.deviceSn || "-"} | Collection: <span className="text-emerald-400">{FIRESTORE_COLLECTION}</span></p>
          </div>

          <div className="flex items-center gap-3">
            <div className="text-xs bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-full text-slate-300 font-mono">
              🕒 Update: {data?.timestamp ? new Date(data.timestamp).toLocaleTimeString() : "-"}
            </div>

            <button
              onClick={() => setIsModalOpen(true)}
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-mono font-semibold px-3.5 py-2 rounded-lg shadow transition flex items-center gap-1.5"
            >
              <span>⚙️</span> Kalibrasi Ah
            </button>
          </div>
        </header>

        {/* Top Summary Banner */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 backdrop-blur-sm shadow flex items-center justify-between">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-wider text-amber-400">☀️ PV</p>
              <h3 className="text-xl font-bold text-white font-mono mt-0.5">
                {system.totalPpv ?? 0}<span className="text-xs font-normal text-slate-400">W</span>
              </h3>
            </div>
            <span className="text-amber-400 text-lg">⚡</span>
          </div>

          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 backdrop-blur-sm shadow flex items-center justify-between">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-wider text-blue-400">🏠 Load</p>
              <h3 className="text-xl font-bold text-white font-mono mt-0.5">
                {system.loadPower ?? 0}<span className="text-xs font-normal text-slate-400">W</span>
              </h3>
            </div>
            <span className="text-blue-400 text-lg">💡</span>
          </div>

          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 backdrop-blur-sm shadow flex items-center justify-between">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-wider text-emerald-400">{isCharging ? '⚡ Charging' : isDischarging ? '🔋 Discharging' : '🔌 Idle'}</p>
              <h3 className="text-xl font-bold text-white font-mono mt-0.5">
                {system.totalPower ?? 0}<span className="text-xs font-normal text-slate-400">W</span>
              </h3>
              <p className="text-[10px] font-medium leading-none mt-1">
                {isCharging ? (
                  <span className="text-emerald-400 font-mono">● {system.totalCurrent}A</span>
                ) : isDischarging ? (
                  <span className="text-red-400 font-mono">● {system.totalCurrent}A</span>
                ) : (
                  <span className="text-slate-400 font-mono">● 0A</span>
                )}
              </p>
            </div>
            <span className="text-emerald-400 text-lg">🔌</span>
          </div>
        </div>

        {/* Cards Grid (Master & Slave) */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

          {/* Master Battery */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-sm shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-blue-400">🔋 Master Battery</h2>
              <span className="text-xs px-2.5 py-1 rounded bg-blue-500/10 text-blue-400 font-medium">Cap: {MASTER_CAPACITY_AH} Ah</span>
            </div>

            <div className="flex items-center gap-6">
              <div className="relative w-16 h-28 border-4 border-slate-700 rounded-xl bg-slate-800 p-1 flex flex-col-reverse overflow-hidden shadow-inner">
                <div
                  className="w-full bg-blue-500 rounded-lg transition-all duration-500 ease-out"
                  style={{ height: `${master.soc ?? 0}%` }}
                />
                <div className="absolute inset-0 flex items-center justify-center z-10 px-1">
                  <span className="text-sm font-black text-white drop-shadow-md tracking-tighter">
                    {master.soc?.toFixed(1) ?? "--"}%
                  </span>
                </div>
                <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-8 h-2 bg-slate-700 rounded-t-md"></div>
              </div>

              <div className="flex-1 space-y-2.5 font-mono">
                <div className="grid grid-cols-2 gap-1 items-center">
                  <p className="text-slate-400 text-sm">Sisa Ah:</p>
                  <p className="text-blue-400 font-bold text-sm text-right">
                    {master.ah !== undefined ? `${master.ah.toFixed(1)} Ah` : "--"}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <p className="text-slate-400 text-sm">Volt:</p>
                  <p className="text-white font-bold text-sm text-right">{master.voltage ?? "--"} V</p>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <p className="text-slate-400 text-sm">Arus:</p>
                  <p className={`font-bold text-sm text-right ${master.current > 0 ? 'text-emerald-400' : master.current < 0 ? 'text-red-400' : 'text-white'}`}>
                    {master.current ?? "--"} A
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <p className="text-slate-400 text-sm">Daya:</p>
                  <p className="text-white font-bold text-sm text-right">{master.power ?? "--"} W</p>
                </div>
              </div>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-800/70 text-xs text-slate-500 flex justify-between">
              <span>SOH: {master.soh ?? "--"}%</span>
              <span>Cycles: {master.cycleCount ?? "--"}</span>
            </div>
          </div>

          {/* Slave Battery */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-sm shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-purple-400">🔋 Slave Battery</h2>
              <span className="text-xs px-2.5 py-1 rounded bg-purple-500/10 text-purple-400 font-medium">Cap: {SLAVE_CAPACITY_AH} Ah</span>
            </div>

            <div className="flex items-center gap-6">
              <div className="relative w-16 h-28 border-4 border-slate-700 rounded-xl bg-slate-800 p-1 flex flex-col-reverse overflow-hidden shadow-inner">
                <div
                  className="w-full bg-purple-500 rounded-lg transition-all duration-500 ease-out"
                  style={{ height: `${slave.soc ?? 0}%` }}
                />
                <div className="absolute inset-0 flex items-center justify-center z-10 px-1">
                  <span className="text-sm font-black text-white drop-shadow-md tracking-tighter">
                    {slave.soc?.toFixed(1) ?? "--"}%
                  </span>
                </div>
                <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-8 h-2 bg-slate-700 rounded-t-md"></div>
              </div>

              <div className="flex-1 space-y-2.5 font-mono">
                <div className="grid grid-cols-2 gap-1 items-center">
                  <p className="text-slate-400 text-sm">Sisa Ah:</p>
                  <p className="text-purple-400 font-bold text-sm text-right">
                    {slave.ah !== undefined ? `${slave.ah.toFixed(1)} Ah` : "--"}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <p className="text-slate-400 text-sm">Volt:</p>
                  <p className="text-white font-bold text-sm text-right">{slave.voltage ?? "--"} V</p>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <p className="text-slate-400 text-sm">Arus:</p>
                  <p className={`font-bold text-sm text-right ${slave.current > 0 ? 'text-emerald-400' : slave.current < 0 ? 'text-red-400' : 'text-white'}`}>
                    {slave.current ?? "--"} A
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <p className="text-slate-400 text-sm">Daya:</p>
                  <p className="text-white font-bold text-sm text-right">{slave.power ?? "--"} W</p>
                </div>
              </div>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-800/70 text-xs text-slate-500 flex justify-between">
              <span>SOH: {slave.soh ?? "--"}%</span>
              <span>Cycles: {slave.cycleCount ?? "--"}</span>
            </div>
          </div>

        </div>

        {/* Charts Section */}

        {/* 1. GRAFIK GABUNGAN POWER (PV vs Load vs Grid dalam 1 Skala Watt) */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-sm shadow-xl">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-4 gap-2">
            <div>
              <h2 className="text-base font-semibold text-slate-200">⚡ Power Overview (PV vs Load vs Grid)</h2>
              <p className="text-xs text-slate-400">Grafik perbandingan daya produksi surya, konsumsi beban, dan daya dari grid PLN.</p>
            </div>
            <div className="flex items-center gap-3 text-[11px] font-mono">
              <span className="flex items-center gap-1 text-amber-400">● PV (W)</span>
              <span className="flex items-center gap-1 text-sky-400">● Load (W)</span>
              <span className="flex items-center gap-1 text-rose-400">● Grid (W)</span>
            </div>
          </div>
          <div className="h-80 w-full">
            <ChartComponent data={powerChartData} />
          </div>
        </div>

        {/* 2. GRAFIK PENDUKUNG (SOC Comparison) */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-sm shadow-xl">
            <h2 className="text-base font-semibold text-slate-200 mb-4">🔋 Grafik Perbandingan SOC (Master vs Slave)</h2>
            <div className="h-64 w-full">
              <ChartComponent data={socChartData} yMin={0} yMax={100} />
            </div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-sm shadow-xl">
            <h2 className="text-base font-semibold text-emerald-400 mb-4">💡 Informasi Sistem</h2>
            <div className="h-64 w-full flex flex-col justify-center space-y-3 text-xs text-slate-300 font-mono px-4 bg-slate-950/40 rounded-xl border border-slate-800/50">
              <p className="flex items-start gap-2">
                <span className="text-amber-400">☀️</span> <span><strong>PV & Load:</strong> Ketika baterai penuh, kurva PV melandai mengikuti beban rumah.</span>
              </p>
              <p className="flex items-start gap-2">
                <span className="text-rose-400">⚡</span> <span><strong>Grid Power:</strong> Menunjukkan seberapa besar sistem mengambil/mengirim daya ke PLN secara *real-time*.</span>
              </p>
            </div>
          </div>
        </div>

      </div>

      {/* POPUP MODAL KALIBRASI AH */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <h3 className="text-lg font-bold text-emerald-400">⚙️ Kalibrasi Nilai Ah Baterai</h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-white text-sm font-mono px-2 py-1 rounded"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCorrectionSubmit} className="space-y-4 font-mono text-sm">
              <div>
                <label className="block text-slate-300 text-xs mb-1">API_SECRET (Bearer Token)</label>
                <input
                  type="password"
                  value={apiSecret}
                  onChange={(e) => setApiSecret(e.target.value)}
                  placeholder="Masukkan API Secret..."
                  required
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                />
                <p className="text-[10px] text-slate-500 mt-1">Disimpan aman otomatis di local storage browser.</p>
              </div>

              <div>
                <label className="block text-purple-400 text-xs mb-1">Target Slave Ah (Opsional)</label>
                <input
                  type="number"
                  step="0.1"
                  value={slaveTargetAh}
                  onChange={(e) => setSlaveTargetAh(e.target.value)}
                  placeholder={`Current: ${slave.ah !== undefined ? slave.ah.toFixed(1) : '0'}`}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-purple-500"
                />
              </div>

              {correctMessage && (
                <div className={`p-2.5 rounded-lg text-xs font-mono text-center ${correctMessage.includes('✅') ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
                  {correctMessage}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={correcting}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold disabled:opacity-50"
                >
                  {correcting ? "Mengirim..." : "Kirim Koreksi"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}

// Komponen Grafik Standar (Satu Sumbu Y untuk Power & SOC terpisah)
function ChartComponent({ data, yMin, yMax }: { data: any; yMin?: number; yMax?: number }) {
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index' as const,
      intersect: false,
    },
    scales: {
      y: {
        min: yMin,
        max: yMax,
        grid: { color: 'rgba(51, 65, 85, 0.4)' },
        ticks: { color: '#94a3b8' }
      },
      x: {
        grid: { display: false },
        ticks: { color: '#94a3b8', maxTicksLimit: 12 }
      }
    },
    plugins: {
      legend: { labels: { color: '#e2e8f0' } }
    }
  };

  return <Line data={data} options={options} />;
}