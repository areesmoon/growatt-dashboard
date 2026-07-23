# ⚡ MyPLTS - Growatt BMS & Virtual Slave Monitor

A real-time monitoring dashboard for Growatt solar inverter systems, featuring dual-battery tracking (Master Hardware BMS & Virtual Slave Ah-Counting) built with **Next.js**, **Tailwind CSS**, **Chart.js**, and **Firebase Firestore**.

![Dashboard Preview](https://img.shields.io/badge/status-active-success.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

---

## 🚀 Key Features

* **Real-Time System Metrics:** Tracks total system voltage, current, power, grid status, and load directly from Growatt inverters.
* **Dual Battery Monitoring:** 
  * **Master Battery:** Real-time data pulled from the physical BMS hardware (SOC, Voltage, Current, Power, Temperature, SOH, Cycle Count).
  * **Slave Battery:** High-precision **Virtual Ah-Counting** with dynamic master-guided correction weights to handle integer-only API limitations smoothly.
* **Interactive Charts:** Live historical trend visualization comparing Master vs. Slave State of Charge (SOC) using Chart.js.
* **Modern Tech Stack:** Built with Next.js (App Router), Tailwind CSS for a sleek cyberpunk/dark theme, and Firebase Firestore as the lightweight backend database.
* **No-Login Access:** Designed for instant internal or public monitoring without tedious authentication screens.

---

## 🛠️ Tech Stack

* **Framework:** [Next.js](https://nextjs.org/) (App Router)
* **Styling:** [Tailwind CSS](https://tailwindcss.com/)
* **Database & Auth:** [Firebase Firestore](https://firebase.google.com/)
* **Charts:** [Chart.js](https://www.chart.js) & [react-chartjs-2](https://github.com/reactchartjs/react-chartjs-2)
* **Inverter API Worker:** Node.js backend worker syncing data via `growatt` package.

---

## ⚙️ Getting Started (Local Development)

### 1. Clone the Repository
```bash
git clone [https://github.com/your-username/myplts-dashboard.git](https://github.com/your-username/myplts-dashboard.git)
cd myplts-dashboard

```

### 2. Install Dependencies

```bash
npm install

```

### 3. Configure Environment Variables

Create a `.env.local` file in the root directory and add your Firebase credentials:

```env
NEXT_PUBLIC_DOMAIN=http://localhost:3000
NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key_here
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project_id.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project_id.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id

```

### 4. Run Development Server

```bash
npm run dev

```

Open [http://localhost:3000](http://localhost:3000) in your browser to view the dashboard.

---

## ☁️ Deployment (Vercel)

1. Push your code to a GitHub repository.
2. Import the project into [Vercel](https://vercel.com/).
3. Add all your `NEXT_PUBLIC_FIREBASE_*` environment variables in the Vercel project settings.
4. Deploy! Link your custom domain (e.g., `myplts.senosoft.net`) under the Vercel Domains settings.

---

## 📄 License

This project is open-source and available under the [MIT License](https://www.google.com/search?q=LICENSE).