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
const SLAVE_CAPACITY_AH = parseFloat(process.env.SLAVE_CAPACITY_AH || '100');
const INV_STANDBY_THRESHOLD = parseFloat(process.env.INV_STANDBY_THRESHOLD_AMP || '-0.4');
const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION || 'bms_logs';

const INTERVAL_MINUTES = parseInt(process.env.INTERVAL_MINUTES || '5', 10);

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
            deviceData: false,
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
        const currentTimestampStr = historyLast.calendar || new Date().toISOString();

        const lastSnapshot = await db.collection(FIRESTORE_COLLECTION)
            .orderBy('timestamp', 'desc')
            .limit(1)
            .get();

        // 10. Menghitung tegangan rata-rata (vBat) antara t-5 dan t-0, serta inisialisasi nilai energi kumulatif
        let totalVoltage = rawTotalVoltage;
        let lastChargeTotal = powerChargeTotal;
        let lastDischargeTotal = powerDischargeTotal;
        const dischgCurr = parseFloat(historyLast.dischgCurr || '0');

        let lastMasterSoc = masterSoc;
        let lastInverterMode = currentInverterMode;
        let lastGridVoltage = gridVoltage;
        let lastTotalPpv = totalPpv;

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

            if (lastDoc.system) {
                lastChargeTotal = lastDoc.system.chargeTotal !== undefined ? lastDoc.system.chargeTotal : powerChargeTotal;
                lastDischargeTotal = lastDoc.system.dischargeTotal !== undefined ? lastDoc.system.dischargeTotal : powerDischargeTotal;
            }

            if (lastDoc.master && lastDoc.master.soc !== undefined) {
                lastMasterSoc = lastDoc.master.soc;
            }
        }

        const masterVoltage = parseFloat(historyLast.bmsBatteryVolt || totalVoltage);
        const masterPower = masterVoltage * masterCurrent;

        // 11. Menghitung arus sementara untuk baterai Slave (Arus sisa mutlak)
        let slaveCurrent = totalCurrent - masterCurrent;
        if (masterSoc === 100 && dischgCurr === -INV_STANDBY_THRESHOLD) {
            slaveCurrent = 0;
        }

        // Inisialisasi variabel tracking & faktor koreksi
        let slaveAh = (masterSoc / 100) * SLAVE_CAPACITY_AH;
        let slaveSoc = masterSoc;
        let chargeCorrectionFactor = 1.0;
        let dischargeCorrectionFactor = 1.0;
        let totalCount = 1;

        // 12. Logika Utama Kalkulasi Arus dan Faktor Koreksi
        if (!lastSnapshot.empty) {
            const lastDoc = lastSnapshot.docs[0].data();

            if (lastDoc.calibration && typeof lastDoc.calibration === 'object') {
                chargeCorrectionFactor = parseFloat(lastDoc.calibration.chargeCorrectionFactor ?? 1.0);
                dischargeCorrectionFactor = parseFloat(lastDoc.calibration.dischargeCorrectionFactor ?? 1.0);
                totalCount = parseInt(lastDoc.calibration.totalCount ?? 1, 10);
            } else {
                console.log("[INFO] Map 'calibration' belum ada di dokumen Firestore sebelumnya. Menggunakan nilai default awal.");
            }

            totalCount += 1;

            const lastSlaveAh = lastDoc.slave && lastDoc.slave.ah !== undefined
                ? lastDoc.slave.ah
                : ((lastDoc.slave ? lastDoc.slave.soc : masterSoc) / 100) * SLAVE_CAPACITY_AH;

            if (masterSoc === 100) {
                slaveAh = SLAVE_CAPACITY_AH;
                slaveSoc = 100.0;
                console.log("[CALIBRATION] Master SOC 100%. Slave Ah & SOC di-reset otomatis penuh ke 100%.");
            } else {
                const hoursDelta = INTERVAL_MINUTES / 60.0;
                let rawSlaveAhDelta = slaveCurrent * hoursDelta;

                if (slaveCurrent > 0) {
                    rawSlaveAhDelta *= chargeCorrectionFactor;
                } else if (slaveCurrent < 0) {
                    rawSlaveAhDelta *= dischargeCorrectionFactor;
                }

                let calculatedSlaveAh = lastSlaveAh + rawSlaveAhDelta;

                // 13. Aturan Pengaman (Standby Lock & Cap Protection)
                const inverterChgCurr = parseFloat(historyLast.chgCurr || '0');
                const slaveSocCheck = (lastSlaveAh / SLAVE_CAPACITY_AH) * 100;

                if ((masterSoc === 100 || lastSlaveAh >= SLAVE_CAPACITY_AH) && (Math.abs(totalCurrent) <= Math.abs(INV_STANDBY_THRESHOLD) || dischgCurr <= Math.abs(INV_STANDBY_THRESHOLD))) {
                    calculatedSlaveAh = SLAVE_CAPACITY_AH;
                    console.log("[STANDBY LOCK] Inverter idle / Standby, Slave Ah dikunci penuh.");
                } else if (lastSlaveAh >= SLAVE_CAPACITY_AH && slaveCurrent > 0) {
                    calculatedSlaveAh = SLAVE_CAPACITY_AH;
                    console.log("[CAP PROTECTION] Slave penuh & masih charging, Ah dikunci.");
                } else if (inverterChgCurr === 0 && slaveSocCheck >= 90.0 && (Math.abs(totalCurrent) <= Math.abs(INV_STANDBY_THRESHOLD) || dischgCurr <= Math.abs(INV_STANDBY_THRESHOLD))) {
                    calculatedSlaveAh = (masterSoc / 100) * SLAVE_CAPACITY_AH;
                    console.log(`[AUTO-SYNC FULL] Inverter berhenti nge-charge dengan SOC tinggi. Ah di-sync selaras dengan Master.`);
                }

                // --- AUTO-CORRECT OTOMATIS (NATIVE TS) ---
                if (lastSlaveAh < SLAVE_CAPACITY_AH && calculatedSlaveAh >= SLAVE_CAPACITY_AH) {
                    console.log(`\n🚨 [AUTO-CORRECT TRIGGER] Slave tembus batas penuh. Menjalankan penyesuaian adaptif otomatis...`);

                    const clampedTargetSlaveAh = SLAVE_CAPACITY_AH;
                    let adjustmentRatio = lastSlaveAh > 0 ? (clampedTargetSlaveAh / lastSlaveAh) : 1.0;
                    let calculatedChargeFactor = chargeCorrectionFactor * adjustmentRatio;
                    let calculatedDischargeFactor = dischargeCorrectionFactor * adjustmentRatio;

                    const learningRate = 0.15;
                    chargeCorrectionFactor = (chargeCorrectionFactor * (1 - learningRate)) + (calculatedChargeFactor * learningRate);
                    dischargeCorrectionFactor = (dischargeCorrectionFactor * (1 - learningRate)) + (calculatedDischargeFactor * learningRate);
                    totalCount = 1;

                    calculatedSlaveAh = SLAVE_CAPACITY_AH;
                    console.log(`✅ [AUTO-CORRECT SUCCESS] Faktor koreksi diperbarui & counter direset.`);
                }

                slaveAh = parseFloat(Math.min(SLAVE_CAPACITY_AH, Math.max(0, calculatedSlaveAh)).toFixed(2));
                slaveSoc = parseFloat(((slaveAh / SLAVE_CAPACITY_AH) * 100).toFixed(2));
                console.log(`[RESULT] Slave Ah: ${slaveAh}Ah / ${SLAVE_CAPACITY_AH}Ah | Slave SOC: ${slaveSoc}%`);
            }
        } else {
            console.log("[BOOTSTRAP] Belum ada data historis di Firestore. Inisialisasi awal Ah berbasis Master.");
        }

        const slaveVoltage = totalVoltage;
        const slavePower = slaveVoltage * slaveCurrent;

        // 14. Menyusun struktur payload dengan Map 'calibration' yang bersih dan fungsional
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
            slave: {
                ah: slaveAh,
                soc: slaveSoc,
                voltage: slaveVoltage,
                current: parseFloat(slaveCurrent.toFixed(2)),
                power: parseFloat(slavePower.toFixed(2))
            },
            calibration: {
                chargeCorrectionFactor: parseFloat(chargeCorrectionFactor.toFixed(4)),
                dischargeCorrectionFactor: parseFloat(dischargeCorrectionFactor.toFixed(4)),
                totalCount: totalCount
            }
        };

        // 15. Pengecekan duplikat data berdasarkan timestamp
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
        // 🚨 WHATSAPP ALERT: Deteksi Perubahan Suplai Beban (PLTS / PLN)
        // -------------------------------------------------------------
        if (lastInverterMode !== currentInverterMode) {
            let modeMessage = "";

            if (currentInverterMode === "SBU") {
                modeMessage = `🔋 *POWER ALERT*\n\nSuplai beban berpindah ke *PLTS*.\n🕒 Waktu: ${timeWib}`;
            } else {
                modeMessage = `⚡ *POWER ALERT*\n\nSuplai beban berpindah ke *PLN*.\n🕒 Waktu: ${timeWib}`;
            }

            try {
                await wa.sendMessage(waNumber, modeMessage);
                console.log(`📨 Notifikasi WA Perubahan Suplai (${currentInverterMode}) berhasil dikirim!`);
            } catch (waError: any) {
                console.error("❌ Gagal kirim notifikasi WA Suplai:", waError.message);
            }
        }

        // -------------------------------------------------------------
        // 🚨 WHATSAPP ALERT: Deteksi Perubahan Status PLN (Mati / Nyala)
        // -------------------------------------------------------------
        const isPlnUpNow = gridVoltage > 150;
        const isPlnUpBefore = lastGridVoltage > 150;

        if (isPlnUpBefore !== isPlnUpNow) {
            let plnAlertMessage = "";

            if (!isPlnUpNow) {
                plnAlertMessage = `🚨 *PLN BLACKOUT ALERT*\n\nJalur PLN padam! Sistem sepenuhnya mengandalkan backup baterai/solar.\n🕒 Waktu: ${timeWib}`;
            } else {
                plnAlertMessage = `⚡ *PLN NORMAL RESTORED*\n\nJalur PLN menyala kembali! Tegangan Grid pulih normal di *${gridVoltage}V*.\n🕒 Waktu: ${timeWib}`;
            }

            try {
                await wa.sendMessage(waNumber, plnAlertMessage);
                console.log(`📨 Notifikasi WA Status PLN (${isPlnUpNow ? 'Nyala Kembali' : 'Padam'}) berhasil dikirim!`);
            } catch (waError: any) {
                console.error("❌ Gagal kirim notifikasi WA Status PLN:", waError.message);
            }
        }

        // -------------------------------------------------------------
        // 🚨 WHATSAPP ALERT: Deteksi Master SOC 100% Penuh
        // -------------------------------------------------------------
        if (lastMasterSoc < 100 && masterSoc === 100) {
            const alertMessage = `🔋 *BMS MASTER FULL ALERT*\n\nBaterai Master baru saja mencapai 100% penuh!\n⚡ Plant: ${plantObj.plantName || "Rumah Kablukan"}\n🕒 Waktu: ${timeWib}`;

            try {
                await wa.sendMessage(waNumber, alertMessage);
                console.log("📨 Notifikasi WhatsApp Master SOC 100% berhasil dikirim!");
            } catch (waError: any) {
                console.error("❌ Gagal kirim notifikasi WA Master 100%:", waError.message);
            }
        }

        // -------------------------------------------------------------
        // 🚨 WHATSAPP ALERT: Deteksi Status Produksi Panel Surya (PPV)
        // -------------------------------------------------------------
        const isSolarProducingNow = totalPpv > 0;
        const isSolarProducingBefore = lastTotalPpv > 0;

        if (isSolarProducingBefore !== isSolarProducingNow) {
            let solarAlertMessage = "";

            if (!isSolarProducingNow) {
                solarAlertMessage = `🌙 *SOLAR PRODUCTION STOPPED*\n\nProduksi panel surya berhenti / habis. Sistem beralih sepenuhnya ke Baterai/PLN.\n🕒 Waktu: ${timeWib}`;
            } else {
                solarAlertMessage = `☀️ *SOLAR PRODUCTION STARTED*\n\nPanel surya mulai berproduksi! Daya terdeteksi *${totalPpv}W*.\n🕒 Waktu: ${timeWib}`;
            }

            try {
                await wa.sendMessage(waNumber, solarAlertMessage);
                console.log(`📨 Notifikasi WA Status Panel Surya (${isSolarProducingNow ? 'Mulai Produksi' : 'Habis'}) berhasil dikirim!`);
            } catch (waError: any) {
                console.error("❌ Gagal kirim notifikasi WA Panel Surya:", waError.message);
            }
        }

        // Ambil threshold dari .env, sediakan nilai default cadangan
        const batToGridThreshold = parseInt(process.env.BAT_TO_GRID_THRESHOLD || '35', 10);
        const batCriticalThreshold = parseInt(process.env.BAT_CRITICAL_THRESHOLD || '22', 10);
        const batCriticalAlert = parseInt(process.env.BAT_CRITICAL_ALERT || '20', 10);

        // -------------------------------------------------------------
        // 🚨 WHATSAPP ALERT 1: Batas Baterai Switch ke Grid/PLN (BAT2GRID)
        // -------------------------------------------------------------
        if (lastMasterSoc > batToGridThreshold && masterSoc <= batToGridThreshold) {
            let bat2GridMessage = `⚡ *SWITCH TO GRID ALERT*\n\nKapasitas baterai PLTS menyentuh *${masterSoc}%* 🔌 Inverter akan switch suplai beban ke jalur PLN.\n🕒 Waktu: ${timeWib}`;

            try {
                await wa.sendMessage(waNumber, bat2GridMessage);
                console.log(`📨 Notifikasi WA BAT2GRID (${masterSoc}%) berhasil dikirim!`);
            } catch (waError: any) {
                console.error("❌ Gagal kirim notifikasi WA BAT2GRID:", waError.message);
            }
        }

        // -------------------------------------------------------------
        // 🚨 WHATSAPP ALERT 2: Early Warning Baterai Kritis (Mau Habis)
        // -------------------------------------------------------------
        if (lastMasterSoc > batCriticalThreshold && masterSoc <= batCriticalThreshold) {
            let earlyWarningMessage = `🚨 *CRITICAL BATTERY WARNING*\n\nKapasitas baterai PLTS turun ke angka *${masterSoc}%*! (Mendekati batas kritis di ${batCriticalAlert}%).\n⚠️ Inverter akan segera shutdown total jika tidak ada suplai lain. Segera ambil tindakan!\n🕒 Waktu: ${timeWib}`;

            try {
                await wa.sendMessage(waNumber, earlyWarningMessage);
                console.log(`📨 Notifikasi WA Baterai Kritis (${masterSoc}%) berhasil dikirim!`);
            } catch (waError: any) {
                console.error("❌ Gagal kirim notifikasi WA Baterai Kritis:", waError.message);
            }
        }

        // 16. Menyimpan dokumen payload baru ke Firestore dengan Custom ID rapi
        const customDocId = currentTimestamp
            .replace(/[:.]/g, '-')
            .replace('T', '_');

        await db.collection(FIRESTORE_COLLECTION).doc(customDocId).set(firestorePayload);
        console.log(`[SUCCESS] Data berhasil disimpan dengan Custom ID: ${customDocId}`);

        return NextResponse.json({ success: true, docId: customDocId, timestamp: currentTimestamp });

    } catch (error: any) {
        console.error("❌ Gagal ambil data Growatt:", error.message);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    } finally {
        // --- CLEAN SESSION: LOGOUT BERSIH DI AKHIR SIKLUS ---
        try {
            await growatt.logout();
            console.log('🔒 Sesi Growatt berhasil ditutup (Logout clean).');
        } catch (logoutErr: any) {
            console.error('⚠️ Gagal logout sesi Growatt:', logoutErr.message);
        }
    }
}