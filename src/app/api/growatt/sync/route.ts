import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
// @ts-ignore
import api from 'growatt';
import wa from '@/lib/whatsapp';

// 1. Inisialisasi koneksi ke Firestore menggunakan environment variables atau service account
if (getApps().length === 0) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY not found");

    const serviceAccount = JSON.parse(raw);

    // Fix line break issue
    if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    }

    initializeApp({
        credential: cert(serviceAccount)
    });
}

const db = getFirestore();

// 2. Memuat konfigurasi kredensial, kapasitas baterai (Ah), threshold, dan nama collection
const username = process.env.GROWATT_USERNAME;
const password = process.env.GROWATT_PASSWORD;
const MASTER_CAPACITY_AH = parseFloat(process.env.MASTER_CAPACITY_AH || '100');
const PV_POWER_MIN = parseFloat(process.env.PV_POWER_MIN || '5');
const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION || 'bms_logs';

// --- HELPER FORMAT WAKTU WIB ---
function formatWibTime(isoString?: string): string {
    const date = isoString ? new Date(isoString) : new Date();
    return date.toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).replace(/\./g, ':');
}

export async function GET(request: NextRequest) {
    // Inisialisasi instance growatt baru untuk setiap siklus request (Stateless / Clean Session)
    const growatt = new api({});

    try {
        // --- KEAMANAN CRON_SECRET ---
        const authHeader = request.headers.get('authorization');
        const urlParams = request.nextUrl.searchParams;
        const querySecret = urlParams.get('secret');
        const bearerToken = authHeader ? authHeader.replace('Bearer ', '') : null;
        const isAuthorized = (process.env.CRON_SECRET && (bearerToken === process.env.CRON_SECRET || querySecret === process.env.CRON_SECRET));

        if (process.env.CRON_SECRET && !isAuthorized) {
            return NextResponse.json({ error: 'Unauthorized: Secret key salah atau tidak ada.' }, { status: 401 });
        }

        // Validasi awal keberadaan kredensial
        if (!username || !password) {
            throw new Error("Kredensial Growatt belum diset di environment variables!");
        }

        // 3. Proses Login Bersih
        console.log('Sesi terputus, melakukan login ke API inverter Growatt...');
        await growatt.login(username, password);

        // 4. Menarik data plant dengan opsi totalData: true untuk statistik energi kumulatif (kWh)
        let plantData = await growatt.getAllPlantData({
            plantData: false,
            deviceData: true,
            weather: false,
            totalData: true,
            statusData: true,
            historyAll: false
        });

        // 5. Mengambil objek data spesifik milik device inverter yang terhubung
        const plantId = Object.keys(plantData)[0];
        const plantObj = plantData[plantId] || {};
        const deviceSn = Object.keys(plantObj.devices || {})[0];
        const deviceNode = plantObj.devices[deviceSn] || {};
        const statusData = deviceNode.statusData || {};
        const historyLast = deviceNode.historyLast || {};
        const totalData = deviceNode.totalData || {};

        // 6.1. gridPower
        const gridPower = parseFloat(statusData.gridPower || '0');
        const currentInverterMode = gridPower > 0 ? "UTI" : "SBU";

        // 6.2. gridVoltage
        const gridVoltage = parseFloat(historyLast.vGrid || '0');

        // 6.3. Mengambil angka energi kumulatif mentah dari inverter (dalam satuan kWh)
        const powerChargeTotal = parseFloat(totalData.chargeTotal || '0');
        const powerDischargeTotal = parseFloat(totalData.eDischargeTotal || '0');

        // 7. Mengambil data mentah tegangan dan daya baterai dari API untuk presisi maksimal
        const rawTotalVoltage = parseFloat(historyLast.vBat || '0');
        const totalPower = parseFloat(historyLast.pBat || '0') * -1; // pBat dibalik polaritasnya agar sinkron

        // [PENYESUAIAN PRESISI]: Arus total dihitung langsung dari pBat / vBat
        let totalCurrent = 0;
        if (rawTotalVoltage > 0) {
            totalCurrent = parseFloat((totalPower / rawTotalVoltage).toFixed(2));
        }

        // Membaca parameter pendukung lain (beban rumah & produksi panel surya/PPV)
        const loadPower = parseFloat(historyLast.outPutPower || '0');
        const ppv1 = parseFloat(historyLast.ppv1 || '0');
        const ppv2 = parseFloat(historyLast.ppv2 || '0');
        const totalPpv = parseFloat((ppv1 + ppv2).toFixed(2));

        // 8. Mengambil data status baterai Master langsung dari BMS inverter (SOC%)
        const masterSoc = parseFloat(parseFloat(historyLast.bmsSoc || '0').toFixed(2));
        const masterCurrent = parseFloat(historyLast.bmsBatteryCurr || '0');

        // Hitung Ah Master mutlak saat ini berdasarkan perkalian SOC% dengan kapasitas nominalnya
        const currentMasterAh = parseFloat(((masterSoc / 100) * MASTER_CAPACITY_AH).toFixed(2));

        // 9. Menarik log snapshot terakhir dari Firestore
        const rawUpdateTime = deviceNode.deviceData?.lastUpdateTime || '';

        let currentTimestampStr = '';
        if (rawUpdateTime) {
            currentTimestampStr = rawUpdateTime.replace(' ', 'T') + '+07:00';
        } else {
            currentTimestampStr = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }).replace(' ', 'T') + '+07:00';
        }

        const lastSnapshot = await db.collection(FIRESTORE_COLLECTION)
            .orderBy('timestamp', 'desc')
            .limit(1)
            .get();

        // 10. Variabel Pendukung System & Master
        let totalVoltage = rawTotalVoltage;
        let lastMasterSoc = masterSoc;
        let lastInverterMode = currentInverterMode;
        let lastGridVoltage = gridVoltage;
        let lastTotalPpv = totalPpv;

        // Default payload slave jika belum ada record sama sekali
        let slavePayload = {
            ah: currentMasterAh,
            soc: masterSoc,
            voltage: totalVoltage,
            current: 0,
            power: 0,
            soh: parseFloat(historyLast.soh || '100'),
            cycleCount: parseInt(historyLast.cycleCount || '0', 10),
            temperature: parseFloat(historyLast.bmsBatteryTemp || '0'),
            statusBms: 'STANDBY',
            cellVoltageAvg: 0
        };

        if (!lastSnapshot.empty) {
            const lastDoc = lastSnapshot.docs[0].data();

            if (lastDoc.system && lastDoc.system.inverterMode) {
                lastInverterMode = lastDoc.system.inverterMode;
            }
            if (lastDoc.system && lastDoc.system.gridVoltage !== undefined) {
                lastGridVoltage = parseFloat(lastDoc.system.gridVoltage) || 0;
            }
            if (lastDoc.system && lastDoc.system.totalPpv !== undefined) {
                lastTotalPpv = parseFloat(lastDoc.system.totalPpv) || 0;
            }

            const lastTotalVoltage = lastDoc.system ? (lastDoc.system.totalVoltage || rawTotalVoltage) : rawTotalVoltage;

            if (lastTotalVoltage > 0 && rawTotalVoltage > 0) {
                totalVoltage = parseFloat(((lastTotalVoltage + rawTotalVoltage) / 2).toFixed(2));
            }

            if (lastDoc.master && lastDoc.master.soc !== undefined) {
                lastMasterSoc = lastDoc.master.soc;
            }

            // AMBIL FULL DATA SLAVE DARI RECORD SEBELUMNYA (Murni dari uploader Python RS485)
            if (lastDoc.slave) {
                slavePayload = {
                    ah: lastDoc.slave.ah !== undefined ? parseFloat(lastDoc.slave.ah) : slavePayload.ah,
                    soc: lastDoc.slave.soc !== undefined ? parseFloat(lastDoc.slave.soc) : slavePayload.soc,
                    voltage: lastDoc.slave.voltage !== undefined ? parseFloat(lastDoc.slave.voltage) : totalVoltage,
                    current: lastDoc.slave.current !== undefined ? parseFloat(lastDoc.slave.current) : 0,
                    power: lastDoc.slave.power !== undefined ? parseFloat(lastDoc.slave.power) : 0,
                    soh: lastDoc.slave.soh !== undefined ? parseFloat(lastDoc.slave.soh) : slavePayload.soh,
                    cycleCount: lastDoc.slave.cycleCount !== undefined ? parseInt(lastDoc.slave.cycleCount, 10) : slavePayload.cycleCount,
                    temperature: lastDoc.slave.temperature !== undefined ? parseFloat(lastDoc.slave.temperature) : slavePayload.temperature,
                    statusBms: lastDoc.slave.statusBms || 'STANDBY',
                    cellVoltageAvg: lastDoc.slave.cellVoltageAvg !== undefined ? parseFloat(lastDoc.slave.cellVoltageAvg) : 0
                };
            }
        }

        const masterVoltage = parseFloat(historyLast.bmsBatteryVolt || totalVoltage);
        const masterPower = masterVoltage * masterCurrent;

        // 11. Menyusun struktur payload final tanpa rumus kalkulasi manual slave
        const currentTimestamp = currentTimestampStr;

        const firestorePayload = {
            timestamp: currentTimestamp,
            deviceSn: deviceSn,
            plantName: plantObj.plantName || "Rumah Kablukan",
            system: {
                totalVoltage,
                totalCurrent: parseFloat(totalCurrent.toFixed(2)),
                totalPower: parseFloat(totalPower.toFixed(2)),
                totalPpv,
                loadPower,
                chargeTotal: powerChargeTotal,
                dischargeTotal: powerDischargeTotal,
                gridVoltage,
                gridFreq: parseFloat(historyLast.freqGrid || '0'),
                inverterTemp: parseFloat(historyLast.InvTemperature || '0'),
                gridPower: gridPower,
                inverterMode: currentInverterMode
            },
            master: {
                ah: currentMasterAh,
                soc: masterSoc,
                voltage: masterVoltage,
                current: masterCurrent,
                power: parseFloat(masterPower.toFixed(2)),
                soh: parseFloat(historyLast.soh || '0'),
                cycleCount: parseInt(historyLast.cycleCount || '0', 10),
                temperature: parseFloat(historyLast.bmsBatteryTemp || '0'),
                statusBms: historyLast.bmsStatus || '0'
            },
            slave: slavePayload
        };

        // 12. Pengecekan duplikat data berdasarkan timestamp
        const existingDocs = await db.collection(FIRESTORE_COLLECTION)
            .where('timestamp', '==', currentTimestamp)
            .limit(1)
            .get();

        if (!existingDocs.empty) {
            console.log(`[SKIP] Data dengan timestamp ${currentTimestamp} sudah ada di Firestore (${FIRESTORE_COLLECTION}).`);
            return NextResponse.json({ success: true, message: "Data sudah ada (skip)" });
        }

        const timeWib = formatWibTime(currentTimestamp);
        const waNumber = process.env.WA_TARGET_NUMBER || '';

        // -------------------------------------------------------------
        // 🚨 WHATSAPP ALERTS (Suplai, PLN, Master 100%, Solar, Bat2Grid, Critical)
        // -------------------------------------------------------------
        if (lastInverterMode !== currentInverterMode) {
            let modeMessage = currentInverterMode === "SBU" 
                ? `🔋 *POWER ALERT*\n\nSuplai beban berpindah ke *PLTS*.\n🕒 Waktu: ${timeWib}`
                : `⚡ *POWER ALERT*\n\nSuplai beban berpindah ke *PLN*.\n🕒 Waktu: ${timeWib}`;
            try { await wa.sendMessage(waNumber, modeMessage); } catch (e: any) { console.error("WA Error:", e.message); }
        }

        const isPlnUpNow = gridVoltage > 150;
        const isPlnUpBefore = lastGridVoltage > 150;
        if (isPlnUpBefore !== isPlnUpNow) {
            let plnMsg = !isPlnUpNow 
                ? `🚨 *PLN BLACKOUT ALERT*\n\nJalur PLN padam!\n🕒 Waktu: ${timeWib}`
                : `⚡ *PLN NORMAL RESTORED*\n\nJalur PLN menyala kembali (${gridVoltage}V).\n🕒 Waktu: ${timeWib}`;
            try { await wa.sendMessage(waNumber, plnMsg); } catch (e: any) { console.error("WA Error:", e.message); }
        }

        if (lastMasterSoc < 100 && masterSoc === 100) {
            try { await wa.sendMessage(waNumber, `🔋 *BMS MASTER FULL ALERT*\n\nBaterai Master mencapai 100% penuh!\n🕒 Waktu: ${timeWib}`); } catch (e: any) {}
        }

        const batToGridThreshold = parseInt(process.env.BAT_TO_GRID_THRESHOLD || '35', 10);
        const batCriticalThreshold = parseInt(process.env.BAT_CRITICAL_THRESHOLD || '22', 10);

        if (lastMasterSoc > batToGridThreshold && masterSoc <= batToGridThreshold) {
            try { await wa.sendMessage(waNumber, `⚡ *SWITCH TO GRID ALERT*\n\nKapasitas baterai menyentuh ${masterSoc}%. Inverter switch ke PLN.\n🕒 Waktu: ${timeWib}`); } catch (e: any) {}
        }

        if (lastMasterSoc > batCriticalThreshold && masterSoc <= batCriticalThreshold) {
            try { await wa.sendMessage(waNumber, `🚨 *CRITICAL BATTERY WARNING*\n\nKapasitas baterai turun ke ${masterSoc}%!\n🕒 Waktu: ${timeWib}`); } catch (e: any) {}
        }

        // 13. Simpan ke Firestore
        const customDocId = currentTimestamp.replace(/[:.]/g, '-').replace('T', '_');
        await db.collection(FIRESTORE_COLLECTION).doc(customDocId).set(firestorePayload);
        console.log(`[SUCCESS] Data berhasil disimpan dengan Custom ID: ${customDocId}`);

        return NextResponse.json({ success: true, docId: customDocId, timestamp: currentTimestamp });

    } catch (error: any) {
        console.error("❌ Gagal ambil data Growatt:", error.message);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    } finally {
        try {
            await growatt.logout();
            console.log('🔒 Sesi Growatt berhasil ditutup (Logout clean).');
        } catch (logoutErr: any) {
            console.error('⚠️ Gagal logout sesi Growatt:', logoutErr.message);
        }
    }
}