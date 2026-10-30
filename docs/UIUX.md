VOTOI SYSTEM UI/UX DESIGN SPECIFICATION


1. Ngôn ngữ Thiết kế & Hệ thống Nhận diện (Visual Identity)

Phong cách của Tatum AI sử dụng giao diện tối giản với độ tương phản cao, tập trung hoàn toàn vào dữ liệu số và trạng thái thực thi của Agent.
• Bảng màu (Color Palette):
	• Nền chủ đạo (Background): Trắng tinh khiết (#FFFFFF) kết hợp các khối phân vùng Xám nhạt (#F8F9FA, #F1F3F5).
	• Chữ & Viền (Typography & Borders): Đen đậm (#1A1A1A) cho văn bản quan trọng, Xám Slate (#4A5568) cho dữ liệu phụ. Đường viền siêu mảnh 1px màu xám (#E2E8F0).
	• Màu Trạng thái (Semantic Colors):
		• Xanh Lá Tatum (#14F195): Biểu thị trạng thái an toàn, giao dịch thành công, ví đã đồng bộ.
		• Cam/Đỏ Hỏa hoạn (#FF4A4A): Biểu thị cảnh báo rủi ro ngân sách (budget_risk), giao dịch bị chặn hoặc phát hiện lừa đảo.
• Font chữ (Typography):
	• Văn bản/Hệ thống: Inter, SF Pro Display (Sạch sẽ, dễ đọc ở kích thước nhỏ).
	• Dữ liệu số/Mã lệnh: JetBrains Mono hoặc Fira Code (Để hiển thị Token, Payload và Số dư tài chính chuẩn Web3).


🔲 2. Bố cục Giao diện 3 Cột (Tatum Agentic Dashboard Layout)

Màn hình làm việc của VOTOI được chia thành 3 khối dọc với đường viền mảnh 1px, không sử dụng hiệu ứng đổ bóng phức tạp.

┌─────────────────┬───────────────────────────────────┬──────────────────────────────┐
│  TOPIC SIDEBAR  │          MAIN INTERACTION         │         AGENT BRAIN          │
│                 │                                   │       (WALRUS & TATUM)       │
├─────────────────┼───────────────────────────────────┼──────────────────────────────┤
│ 📁 Oct Budget   │  [Card: Receipt processed]        │ 💳 WALLET STATUS (SUI)       │
│ 📁 Coffee habit │  Katinat Coffee • $2.60           │    Balance: 1,420.50 USD     │
│ 📁 Onchain Tx   │  ┌──────────────────────────────┐ │                              │
│                 │  │ ⚡ OCR Async Worker: Active   │ │ 🧠 DEEPEST LEARNING LOOP     │
│ 🔘 Temporary    │  │ 📦 Walrus Blob: 9f4c...e21a  │ │    [Fact v2] merchant_habit  │
│    Chat         │  └──────────────────────────────┘ │    [Fact v1] budget_risk     │
│                 │                                   │                              │
│                 │  🤖 "Warning: 5th coffee today."  │ 🛑 PRE-EXECUTION SANDBOX     │
│                 │                                   │    [Button: Wipe Cache]      │
│                 │ ───────────────────────────────── │                              │
│                 │ [ ⌕ Ask VOTOI or upload bill... ] │ [ Live Webhook Stream ]      │
└─────────────────┴───────────────────────────────────┴──────────────────────────────┘


Cột 1: Danh mục Phiên & Trạng thái Bộ nhớ (15% Width)

• Tính năng: Hiển thị các chủ đề theo dõi tài chính.
• Điểm nhấn UX theo style Tatum: Tích hợp công tắc chuyển đổi giữa Persistent Topic (Ghi nhớ vĩnh viễn vào Walrus) và Temporary Chat (Chat nhanh, không lưu bộ nhớ) có biểu tượng chấm tròn nhấp nháy chỉ báo trạng thái.

Cột 2: Không gian tương tác chính & Tiến trình AI (50% Width)

Mô phỏng lại phần "What one prompt covered" của Tatum AI, mỗi khi người dùng tải tệp hoặc ra lệnh, giao diện hiển thị các Khối tiến trình (Process Badges) dạng chữ đen nền xám nhạt:
• Thẻ xử lý hóa đơn Đa phương thức: Khi chụp ảnh biên lai, UI render ngay một Card dạng:
	• [IMAGE_UPLOADED] camera_capture_01.jpg
	• [WALRUS_STORAGE] walrus://blob/9f4c...e21a
	• [VISION_AI] Extracting fields: Merchant, Amount, Currency
	• [COMPLETED] Katinat Coffee | $2.60 USD | Category: Dining
• Hero Input Composer: Khung chat phẳng đặt ở đáy cột, chứa nút Camera Icon và Upload Icon tối giản.

Cột 3: Trung tâm Giám sát Bộ não (Agent Brain Pane - 35% Width)

Cột này thiết kế đặc dụng để Giám khảo nhìn thấy trực quan "Vòng lặp học tập sâu nhất" (Deepest Learning Loop).
• Khối 3.1: Wallet Intelligence (Tatum RPC Layer): Hiển thị số dư USD/SUI hiện tại. Phía dưới có một danh sách dạng dòng lệnh (Terminal-style) stream trực tiếp các transaction onchain mà Tatum Webhook vừa bắn về:
	• • block 8412 | Gas Burn | -0.01 SUI
	• • block 8411 | Contract Transfer | -$14.50 USD
• Khối 3.2: Portable Memory Monitor (Walrus Fact Stream): Render toàn bộ các Clean Facts (Sự thật có cấu trúc) đang lưu trên Walrus Mainnet dưới dạng các thẻ Badge chữ đen trên nền bo góc mảnh:
	• [v2][merchant_habit] starbucks | 5 times per week | average $8.50
	• [v1][budget_risk] dining | 85% budget reached | strict warnings active
• Khối 3.3: Nút biểu diễn (The Rehydration Trigger): Một nút bấm phẳng màu đỏ viền mảnh: [Wipe Postgres Cache]. Khi bấm vào, các thẻ Fact ở Khối 3.2 sẽ biến mất kèm hiệu ứng mờ (Fade out). Khi gửi tin nhắn mới, các thẻ này sẽ tự động xuất hiện lại kèm hiệu ứng chuyển động nạp dữ liệu (Streaming flow) để chứng minh luồng kéo dữ liệu trực tiếp từ Walrus Mainnet (State Rehydration Flow).


💻 3. Component Code Mẫu (React/Next.js + Tailwind CSS) cho Cột 3 (Brain Pane)

Bạn có thể đưa đoạn code mẫu chuẩn style Tatum này vào Cursor để sinh nhanh giao diện hiển thị bộ não của Agent:

import React from 'react';
import { Shield, Brain, Wallet, RefreshCw } from 'lucide-react';

export default function AgentBrainPane({ walletAddress, balance, learnedFacts, onWipeCache, isRehydrating }) {
  return (
    <div className="w-full h-full bg-white border-l border-gray-200 text-[#1A1A1A] font-sans flex flex-col">
      {/* Block 1: Wallet Intelligence (Tatum API) */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-gray-500">
            <Wallet size={14} /> Wallet Status (Tatum RPC)
          </div>
          <span className="h-2 w-2 rounded-full bg-[#14F195] animate-pulse" />
        </div>
        <div className="font-mono text-2xl font-bold tracking-tight">${balance} <span className="text-sm font-normal text-gray-400">USD</span></div>
        <div className="text-[10px] font-mono text-gray-400 truncate mt-1">{walletAddress}</div>
      </div>

      {/* Block 2: Deepest Learning Loop Monitor (Walrus Memory) */}
      <div className="p-4 flex-1 overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-gray-500">
            <Brain size={14} /> Deepest Learning Loop (Walrus)
          </div>
          <button 
            onClick={onWipeCache}
            className="text-[10px] font-mono px-2 py-0.5 border border-red-200 text-red-500 rounded hover:bg-red-50 transition-colors"
          >
            [Wipe Postgres Cache]
          </button>
        </div>

        {isRehydrating ? (
          <div className="flex flex-col items-center justify-center py-12 text-gray-400 font-mono text-xs gap-2">
            <RefreshCw size={16} className="animate-spin text-gray-400" />
            Rehydrating from Walrus Mainnet...
          </div>
        ) : (
          <div className="space-y-3">
            {learnedFacts.map((fact, index) => (
              <div key={index} className="p-3 bg-[#F8F9FA] border border-gray-200 rounded font-mono text-xs">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] uppercase font-bold text-gray-400">
                    [{fact.type}]
                  </span>
                  <span className="bg-[#1A1A1A] text-white text-[9px] px-1 rounded">
                    v{fact.version}
                  </span>
                </div>
                <p className="text-gray-700 leading-relaxed">{fact.payload}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Block 3: Pre-execution Simulator Output */}
      <div className="p-4 border-t border-gray-200 bg-[#F1F3F5]">
        <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-gray-500 mb-2">
          <Shield size={14} /> Tatum Transaction Simulator
        </div>
        <div className="bg-[#1A1A1A] text-[#14F195] p-3 rounded font-mono text-[11px] leading-tight">
          <div>$ sui client call --gas-budget 10000000</div>
          <div className="text-white mt-1">[SIMULATION STATUS] APPROVAL_CLEAR</div>
          <div className="text-gray-400 text-[10px]">Projected spending aligns with active Walrus constraints.</div>
        </div>
      </div>
    </div>
  );
}

