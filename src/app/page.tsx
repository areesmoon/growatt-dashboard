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

export default function Dashboard() {
  const [data, setData] = useState<any>(null);
  const [chartData, setChartData] = useState<any>({ labels: [], datasets: [] });
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      const q = query(collection(db, "bms_logs"), orderBy("timestamp", "desc"), limit(20));
      const querySnapshot = await getDocs(q);
      
      let docs: any[] = [];
      querySnapshot.forEach((doc) => {
        docs.push(doc.data());
      });

      if (docs.length > 0) {
        setData(docs[0]); // Ambil data paling baru

        // Urutkan kronologis untuk chart (dari lama ke baru)
        const reversed = [...docs].reverse();
        const labels = reversed.map(d => new Date(d.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
        const masterSoc = reversed.map(d => d.master.soc);
        const slaveSoc = reversed.map(d => d.slave.soc);

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

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-6">
        
        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center border-b border-slate-800 pb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-emerald-400">⚡ {data?.plantName || "BMS Monitor"}</h1>
            <p className="text-xs text-slate-400 font-mono">Device SN: {data?.deviceSn || "-"}</p>
          </div>
          <div className="text-xs bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-full text-slate-300 mt-2 md:mt-0 font-mono">
            🕒 Update: {data?.timestamp ? new Date(data.timestamp).toLocaleTimeString() : "-"}
          </div>
        </header>

        {/* Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          
          {/* Master Battery */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-sm shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-blue-400">🔋 Master Battery</h2>
              <span className="text-xs px-2.5 py-1 rounded bg-blue-500/10 text-blue-400 font-medium">Hardware BMS</span>
            </div>
            <div className="grid grid-cols-2 gap-4 items-center">
              <div>
                <p className="text-xs text-slate-400 uppercase tracking-wider">State of Charge</p>
                <p className="text-5xl font-black mt-1 text-white">
                  {master.soc ?? "--"}<span className="text-2xl text-slate-400">%</span>
                </p>
              </div>
              <div className="space-y-1.5 text-sm font-mono border-l border-slate-800 pl-4">
                <p className="text-slate-300">Tegangan: <span className="text-white font-bold">{master.voltage ?? "--"} V</span></p>
                <p className="text-slate-300">Arus: <span className="text-white font-bold">{master.current ?? "--"} A</span></p>
                <p className="text-slate-300">Daya: <span className="text-white font-bold">{master.power ?? "--"} W</span></p>
              </div>
            </div>
          </div>

          {/* Slave Battery */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-sm shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-purple-400">🔋 Slave Battery</h2>
              <span className="text-xs px-2.5 py-1 rounded bg-purple-500/10 text-purple-400 font-medium">Virtual Ah</span>
            </div>
            <div className="grid grid-cols-2 gap-4 items-center">
              <div>
                <p className="text-xs text-slate-400 uppercase tracking-wider">State of Charge</p>
                <p className="text-5xl font-black mt-1 text-purple-300">
                  {slave.soc ?? "--"}<span className="text-2xl text-slate-400">%</span>
                </p>
              </div>
              <div className="space-y-1.5 text-sm font-mono border-l border-slate-800 pl-4">
                <p className="text-slate-300">Tegangan: <span className="text-white font-bold">{slave.voltage ?? "--"} V</span></p>
                <p className="text-slate-300">Arus: <span className="text-white font-bold">{slave.current ?? "--"} A</span></p>
                <p className="text-slate-300">Daya: <span className="text-white font-bold">{slave.power ?? "--"} W</span></p>
              </div>
            </div>
          </div>

        </div>

        {/* Chart Section */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-sm shadow-xl">
          <h2 className="text-base font-semibold text-slate-200 mb-4">📈 Grafik Perbandingan SOC (Master vs Slave)</h2>
          <div className="h-72 w-full">
            <ChartComponent data={chartData} />
          </div>
        </div>

      </div>
    </main>
  );
}

// Komponen pembantu untuk Chart agar aman dari SSR hydration error di Next.js
function ChartComponent({ data }: { data: any }) {
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      y: {
        min: 0,
        max: 100,
        grid: { color: 'rgba(51, 65, 85, 0.4)' },
        ticks: { color: '#94a3b8' }
      },
      x: {
        grid: { display: false },
        ticks: { color: '#94a3b8' }
      }
    },
    plugins: {
      legend: { labels: { color: '#e2e8f0' } }
    }
  };

  return <Line data={data} options={options} />;
}