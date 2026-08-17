import axios, { AxiosResponse } from 'axios';

interface WhatsAppV2Config {
    baseUrl: string;
    apiKey: string;
    apiToken: string;
    targetBotId?: string;
}

interface ApiResponseData {
    success?: boolean;
    message?: string;
    data?: {
        messageId?: string;
        tenantId?: string;
        botId?: string;
        to?: string;
        isGroup?: boolean;
        status?: string;
    };
    error?: string;
    [key: string]: any;
}

class WhatsAppV2Service {
    private config: WhatsAppV2Config;

    constructor() {
        const apiKey = process.env.WAGATE_API_KEY || '';
        const apiToken = process.env.WAGATE_API_TOKEN || '';
        const baseUrl = (process.env.WAGATE_API_URL || 'https://wagate.senosoft.net').replace(/\/$/, '');
        const targetBotId = process.env.WAGATE_BOT_ID || undefined;

        // --- DEBUG CREDENTIALS ---
        console.log(`🔍 [WAGATE DEBUG] Base URL: ${baseUrl}`);
        console.log(`🔍 [WAGATE DEBUG] API Key Loaded: ${apiKey ? 'YES' : 'NO'}`);
        console.log(`🔍 [WAGATE DEBUG] API Token Loaded: ${apiToken ? 'YES' : 'NO'}`);
        if (targetBotId) {
            console.log(`🔍 [WAGATE DEBUG] Target Bot ID Override: ${targetBotId}`);
        }

        this.config = {
            baseUrl,
            apiKey,
            apiToken,
            targetBotId,
        };
    }

    /**
     * 🚀 HELPER: Bersihkan nomor telepon dari spasi/karakter aneh & standarisasi ke format (62)
     */
    public cleanPhoneNumber(whatsappNumber?: string): string {
        if (!whatsappNumber) return '';
        
        const trimmed = whatsappNumber.trim();
        
        // Jika nomor berupa Group ID (berakhiran @g.us), pertahankan formatnya
        if (trimmed.endsWith('@g.us') || trimmed.includes('@g.us')) {
            return trimmed.endsWith('@g.us') ? trimmed : `${trimmed}@g.us`;
        }
        
        let cleanNumber = trimmed.replace(/[^0-9]/g, '');
        
        if (cleanNumber.startsWith('0')) {
            cleanNumber = '62' + cleanNumber.slice(1);
        } else if (cleanNumber.startsWith('8')) {
            cleanNumber = '62' + cleanNumber;
        }
        
        return cleanNumber;
    }

    /**
     * 🛰️ Panggilan API utama ke Gateway /api/v1/messages/send
     */
    private async callSendApi(to: string, message: string, groupName?: string): Promise<AxiosResponse<ApiResponseData>> {
        const endpoint = `${this.config.baseUrl}/api/v1/messages/send`;

        const payload: Record<string, any> = {
            to,
            message,
        };

        if (this.config.targetBotId) {
            payload.botId = this.config.targetBotId;
        }

        if (groupName && to.endsWith('@g.us')) {
            payload.groupName = groupName;
        }

        console.log(`🚀 [WAGATE API CALL] Target URL: ${endpoint}`);
        console.log(`🎯 [WAGATE API CALL] Target Recipient: ${to}`);

        return axios.post<ApiResponseData>(endpoint, payload, {
            headers: { 
                'x-api-key': this.config.apiKey,
                'x-api-token': this.config.apiToken,
                'Content-Type': 'application/json'
            },
            timeout: 30000 // Timeout 30 detik
        });
    }

    /**
     * 🚀 SEND MESSAGE
     */
    public async sendMessage(whatsappNumber?: string, message?: string, groupName?: string): Promise<ApiResponseData> {
        const formattedTo = this.cleanPhoneNumber(whatsappNumber);
        
        if (!formattedTo) {
            console.warn('⚠️ Gagal kirim WA: Nomor telepon/Group ID kosong atau tidak valid.');
            return { success: false, message: 'Skipped due to empty or invalid recipient' };
        }

        if (!message || !message.trim()) {
            console.warn('⚠️ Gagal kirim WA: Isi pesan tidak boleh kosong.');
            return { success: false, message: 'Skipped due to empty message' };
        }

        try {
            const response = await this.callSendApi(formattedTo, message.trim(), groupName);
            const resData = response.data;

            if (resData && !resData.success) {
                throw new Error(resData.error || resData.message || 'Gagal mengirim pesan via Gateway.');
            }

            return resData;
        } catch (error: any) {
            const errorDetails = error.response?.data?.error || error.message || error;
            console.error(`❌ [WAGATE SERVICE ERROR]:`, errorDetails);
            throw new Error(typeof errorDetails === 'string' ? errorDetails : JSON.stringify(errorDetails));
        }
    }

    /**
     * 📦 QUEUE MESSAGE (Alias untuk sendMessage agar interface-nya identik)
     */
    public async queueMessage(whatsappNumber?: string, message?: string, groupName?: string): Promise<ApiResponseData> {
        return this.sendMessage(whatsappNumber, message, groupName);
    }
}

// Export instance tunggal
export default new WhatsAppV2Service();