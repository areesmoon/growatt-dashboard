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
  const [chartData, setChartData] = useState<any>({ labels: [], datasets: [] });
  const [pvChartData, setPvChartData] = useState<any>({ labels: [], datasets: [] });
  const [loadChartData, setLoadChartData] = useState<any>({ labels: [], datasets: [] });
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      // Tarik limit 300 data untuk mencakup data penuh seharian (00:00 - selesai)
      const q = query(collection(db, FIRESTORE_COLLECTION), orderBy("timestamp", "desc"), limit(300));
      const querySnapshot = await getDocs(q);

      let docs: any[] = [];
      querySnapshot.forEach((doc) => {
        docs.push(doc.data());
      });

      if (docs.length > 0) {
        setData(docs[0]); // Ambil data paling baru untuk card atas

        // Urutkan kronologis untuk chart (dari yang paling lama ke yang terbaru hari ini)
        const reversed = [...docs].reverse();
        const labels = reversed.map(d => new Date(d.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

        const masterSoc = reversed.map(d => d.master.soc);
        const slaveSoc = reversed.map(d => d.slave.soc);
        const pvProduction = reversed.map(d => d.system.totalPpv || 0);
        const loadConsumption = reversed.map(d => d.system.loadPower || 0);

        setChartData({
          labels,
          datasets: [
            {
              label: 'Master SOC (%)',
              data: masterSoc,
              borderColor: '#60a5fa',
              backgroundColor: 'rgba(96, 165, 250, 0.1)',
              fill: true,
              tension: 0.3,
            },
            {
              label: 'Slave SOC (%)',
              data: slaveSoc,
              borderColor: '#c084fc',
              backgroundColor: 'rgba(192, 132, 252, 0.1)',
              fill: true,
              tension: 0.3,
            }
          ]
        });

        setPvChartData({
          labels,
          datasets: [
            {
              label: 'PV Production (W)',
              data: pvProduction,
              borderColor: '#fbbf24',
              backgroundColor: 'rgba(251, 191, 36, 0.1)',
              fill: true,
              tension: 0.3,
            }
          ]
        });

        setLoadChartData({
          labels,
          datasets: [
            {
              label: 'Load Consumption (W)',
              data: loadConsumption,
              borderColor: '#38bdf8',
              backgroundColor: 'rgba(56, 189, 248, 0.1)',
              fill: true,
              tension: 0.3,
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
    const interval = setInterval(fetchData, 30000); // Auto-refresh tiap 30 detik
    return () => clearInterval(interval);
  }, []);

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
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center border-b border-slate-800 pb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-emerald-400">⚡ {data?.plantName || "BMS Monitor"}</h1>
            <p className="text-xs text-slate-400 font-mono">Device SN: {data?.deviceSn || "-"} | Collection: <span className="text-emerald-400">{FIRESTORE_COLLECTION}</span></p>
          </div>
          <div className="text-xs bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-full text-slate-300 mt-2 md:mt-0 font-mono">
            🕒 Update: {data?.timestamp ? new Date(data.timestamp).toLocaleTimeString() : "-"}
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
              <p className="text-[10px] font-mono uppercase tracking-wider text-emerald-400">🔋 Charging</p>
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
            <div className="mt-4 pt-3 border-t border-slate-800/70 text-xs text-slate-500 text-center">
              <span>Virtual Ah Calculation (Energy-to-Ah Integration)</span>
            </div>
          </div>

        </div>

        {/* Charts Section (SOC, PV Production, Load Consumption) */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* SOC Chart */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-sm shadow-xl">
            <h2 className="text-base font-semibold text-slate-200 mb-4">📈 Grafik Perbandingan SOC (Full Day)</h2>
            <div className="h-64 w-full">
              <ChartComponent data={chartData} yMin={0} yMax={100} />
            </div>
          </div>

          {/* PV Production Chart */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-sm shadow-xl">
            <h2 className="text-base font-semibold text-amber-400 mb-4">☀️ Grafik PV Production (W)</h2>
            <div className="h-64 w-full">
              <ChartComponent data={pvChartData} />
            </div>
          </div>
        </div>

        {/* Load Consumption Chart (Full Span) */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-sm shadow-xl">
          <h2 className="text-base font-semibold text-sky-400 mb-4">🏠 Grafik Load Consumption (W) - Full Day</h2>
          <div className="h-64 w-full">
            <ChartComponent data={loadChartData} />
          </div>
        </div>

      </div>
    </main>
  );
}

// Komponen pembantu untuk Chart agar aman dari SSR hydration error di Next.js
function ChartComponent({ data, yMin, yMax }: { data: any; yMin?: number; yMax?: number }) {
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      y: {
        min: yMin,
        max: yMax,
        grid: { color: 'rgba(51, 65, 85, 0.4)' },
        ticks: { color: '#94a3b8' }
      },
      x: {
        grid: { display: false },
        ticks: { color: '#94a3b8', maxTicksLimit: 12 } // Batasi jumlah label di sumbu X biar gak numpuk
      }
    },
    plugins: {
      legend: { labels: { color: '#e2e8f0' } }
    }
  };

  return <Line data={data} options={options} />;
}