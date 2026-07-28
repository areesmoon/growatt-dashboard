import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Inisialisasi Firebase Admin aman dari multiple instances di Next.js
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

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION || 'bms_logs';
const MASTER_CAPACITY_AH = parseFloat(process.env.NEXT_PUBLIC_MASTER_CAPACITY_AH || process.env.MASTER_CAPACITY_AH || '200');
const SLAVE_CAPACITY_AH = parseFloat(process.env.NEXT_PUBLIC_SLAVE_CAPACITY_AH || process.env.SLAVE_CAPACITY_AH || '100');

export async function POST(request: NextRequest) {
    try {
        // 1. Keamanan Token Header / Secret Key dari request
        const authHeader = request.headers.get('authorization');
        const bearerToken = authHeader ? authHeader.replace('Bearer ', '') : null;
        
        // Cek secret dari API_SECRET atau fallback ke CRON_SECRET
        const validSecret = process.env.API_SECRET || process.env.CRON_SECRET;
        const isAuthorized = validSecret ? (bearerToken === validSecret) : true;

        if (validSecret && !isAuthorized) {
            return NextResponse.json({ success: false, error: 'Unauthorized: API Secret salah atau tidak ada.' }, { status: 401 });
        }

        // 2. Ambil payload body JSON dari frontend dashboard
        const body = await request.json().catch(() => ({}));
        const targetMasterAh = body.masterAh !== undefined ? parseFloat(body.masterAh) : NaN;
        const targetSlaveAh = body.slaveAh !== undefined ? parseFloat(body.slaveAh) : NaN;

        if (isNaN(targetMasterAh) && isNaN(targetSlaveAh)) {
            return NextResponse.json(
                { success: false, error: "Minimal salah satu (masterAh atau slaveAh) wajib diisi dengan format angka yang valid!" },
                { status: 400 }
            );
        }

        const collectionRef = db.collection(FIRESTORE_COLLECTION);

        // 3. Ambil data TERAKHIR (limit 1 descending)
        const lastSnapshot = await collectionRef.orderBy('timestamp', 'desc').limit(1).get();
        if (lastSnapshot.empty) {
            return NextResponse.json(
                { success: false, error: `Tidak ada data ditemukan di collection: ${FIRESTORE_COLLECTION}` },
                { status: 404 }
            );
        }

        const lastDoc = lastSnapshot.docs[0];
        const lastData = lastDoc.data();
        const lastId = lastDoc.id;

        console.log(`📄 Dokumen Terakhir [ID: ${lastId}] : ${lastData.timestamp}`);

        let updates: Record<string, any> = {};
        let responsePayload: Record<string, any> = { success: true, updatedDocId: lastId };
        const learningRate = 0.15;

        // --- PROSES KALIBRASI MASTER ---
        if (!isNaN(targetMasterAh)) {
            const clampedMasterAh = Math.min(MASTER_CAPACITY_AH, Math.max(0, targetMasterAh));
            const oldMasterAh = parseFloat(lastData.master?.ah || '0');
            const masterCalib = lastData.master?.calibration || lastData.calibration || {};
            const oldChargeFactor = parseFloat(masterCalib.chargeCorrectionFactor || '1.0');
            const oldDischargeFactor = parseFloat(masterCalib.dischargeCorrectionFactor || '1.0');

            // Cek status arus/daya master (positif = charging, negatif/nol = discharging)
            const masterCurrent = parseFloat(lastData.master?.current ?? lastData.master?.power ?? 0);
            const isMasterCharging = masterCurrent > 0;

            let adjustmentRatio = oldMasterAh > 0 ? (clampedMasterAh / oldMasterAh) : 1.0;
            const newMasterSoc = parseFloat(((clampedMasterAh / MASTER_CAPACITY_AH) * 100).toFixed(2));

            updates["master.ah"] = clampedMasterAh;
            updates["master.soc"] = newMasterSoc;
            responsePayload.master = {
                targetAh: clampedMasterAh,
                newSoc: newMasterSoc,
                status: isMasterCharging ? "CHARGING" : "DISCHARGING"
            };

            if (isMasterCharging) {
                // Hanya ubah chargeCorrectionFactor
                const rawNewChargeFactor = oldChargeFactor * adjustmentRatio;
                const finalChargeFactor = (oldChargeFactor * (1 - learningRate)) + (rawNewChargeFactor * learningRate);

                updates["master.calibration.chargeCorrectionFactor"] = parseFloat(finalChargeFactor.toFixed(4));
                updates["master.calibration.totalCount"] = 1;

                responsePayload.master.adjustedFactorType = "chargeCorrectionFactor";
                responsePayload.master.newChargeFactor = parseFloat(finalChargeFactor.toFixed(4));
                console.log(`🔋 Master Calibrated (Charging): Target ${clampedMasterAh}Ah | New Charge Factor: ${finalChargeFactor.toFixed(4)}`);
            } else {
                // Hanya ubah dischargeCorrectionFactor
                const rawNewDischargeFactor = oldDischargeFactor * adjustmentRatio;
                const finalDischargeFactor = (oldDischargeFactor * (1 - learningRate)) + (rawNewDischargeFactor * learningRate);

                updates["master.calibration.dischargeCorrectionFactor"] = parseFloat(finalDischargeFactor.toFixed(4));
                updates["master.calibration.totalCount"] = 1;

                responsePayload.master.adjustedFactorType = "dischargeCorrectionFactor";
                responsePayload.master.newDischargeFactor = parseFloat(finalDischargeFactor.toFixed(4));
                console.log(`🔋 Master Calibrated (Discharging): Target ${clampedMasterAh}Ah | New Discharge Factor: ${finalDischargeFactor.toFixed(4)}`);
            }
        }

        // --- PROSES KALIBRASI SLAVE ---
        if (!isNaN(targetSlaveAh)) {
            const clampedSlaveAh = Math.min(SLAVE_CAPACITY_AH, Math.max(0, targetSlaveAh));
            const oldSlaveAh = parseFloat(lastData.slave?.ah || '0');
            const slaveCalib = lastData.slave?.calibration || lastData.calibration || {};
            const oldChargeFactor = parseFloat(slaveCalib.chargeCorrectionFactor || '1.0');
            const oldDischargeFactor = parseFloat(slaveCalib.dischargeCorrectionFactor || '1.0');

            // Cek status arus/daya slave (positif = charging, negatif/nol = discharging)
            const slaveCurrent = parseFloat(lastData.slave?.current ?? lastData.slave?.power ?? 0);
            const isSlaveCharging = slaveCurrent > 0;

            let adjustmentRatio = oldSlaveAh > 0 ? (clampedSlaveAh / oldSlaveAh) : 1.0;
            const newSlaveSoc = parseFloat(((clampedSlaveAh / SLAVE_CAPACITY_AH) * 100).toFixed(2));

            updates["slave.ah"] = clampedSlaveAh;
            updates["slave.soc"] = newSlaveSoc;
            responsePayload.slave = {
                targetAh: clampedSlaveAh,
                newSoc: newSlaveSoc,
                status: isSlaveCharging ? "CHARGING" : "DISCHARGING"
            };

            if (isSlaveCharging) {
                // Hanya ubah chargeCorrectionFactor
                const rawNewChargeFactor = oldChargeFactor * adjustmentRatio;
                const finalChargeFactor = (oldChargeFactor * (1 - learningRate)) + (rawNewChargeFactor * learningRate);

                updates["slave.calibration.chargeCorrectionFactor"] = parseFloat(finalChargeFactor.toFixed(4));
                updates["slave.calibration.totalCount"] = 1;

                responsePayload.slave.adjustedFactorType = "chargeCorrectionFactor";
                responsePayload.slave.newChargeFactor = parseFloat(finalChargeFactor.toFixed(4));
                console.log(`🔋 Slave Calibrated (Charging): Target ${clampedSlaveAh}Ah | New Charge Factor: ${finalChargeFactor.toFixed(4)}`);
            } else {
                // Hanya ubah dischargeCorrectionFactor
                const rawNewDischargeFactor = oldDischargeFactor * adjustmentRatio;
                const finalDischargeFactor = (oldDischargeFactor * (1 - learningRate)) + (rawNewDischargeFactor * learningRate);

                updates["slave.calibration.dischargeCorrectionFactor"] = parseFloat(finalDischargeFactor.toFixed(4));
                updates["slave.calibration.totalCount"] = 1;

                responsePayload.slave.adjustedFactorType = "dischargeCorrectionFactor";
                responsePayload.slave.newDischargeFactor = parseFloat(finalDischargeFactor.toFixed(4));
                console.log(`🔋 Slave Calibrated (Discharging): Target ${clampedSlaveAh}Ah | New Discharge Factor: ${finalDischargeFactor.toFixed(4)}`);
            }
        }

        // 4. Eksekusi update dokumen terakhir di Firestore
        await collectionRef.doc(lastId).update(updates);

        console.log(`\n✅ Berhasil update database [ID: ${lastId}] via POST (Selective Factor Correction)!`);
        return NextResponse.json(responsePayload);

    } catch (error: any) {
        console.error("❌ Gagal menjalankan koreksi adaptif:", error.message);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}