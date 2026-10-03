# FSRS Ôn Tập Thông Minh

Ứng dụng học từ vựng & ngữ pháp tiếng Anh với thuật toán lặp lại ngắt quãng FSRS v4.

## Kiến trúc

- **Frontend**: React 19 + Vite, TypeScript.
- **Xác thực**: Supabase Auth (Email/Password).
- **Lưu trữ dữ liệu**: Supabase Database (Postgres + RLS) — mỗi từ vựng/ngữ pháp được lưu theo tài khoản người dùng, đồng bộ trên mọi thiết bị. Bản sao cục bộ (IndexedDB/localStorage) vẫn được giữ để dùng ngay cả khi mất mạng.
- **AI hỗ trợ**: Netlify Functions gọi Gemini API để tra cứu từ vựng/ngữ pháp và tối ưu tham số FSRS, có chế độ dự phòng offline khi không có API key.

## Giao diện

- **Bố cục**: thanh điều hướng bên trái trên máy tính (thu gọn thành cột biểu tượng ở màn hình vừa), thanh tiêu đề theo ngữ cảnh ở trên, thanh điều hướng dưới cùng + nút thêm nổi trên điện thoại.
- **Design tokens**: bảng màu trung tính, màu thương hiệu, bóng đổ, font (Be Vietnam Pro + JetBrains Mono) được khai báo một lần trong `@theme` ở `src/index.css`.
- **Phím tắt**: `N` mở cửa sổ thêm mới, `1`–`6` chuyển nhanh giữa các mục (tắt khi đang ở Thẻ lật và Game).

## Chạy trên máy

```bash
npm install
netlify dev
```

## Luyện Output 5 ngữ cảnh (Gemini)

Khi mở cửa sổ luyện output của một từ vựng hoặc cấu trúc ngữ pháp:

1. Gemini gợi ý 5 ngữ cảnh thực tế phù hợp nhất với từ/cấu trúc đó và hiển thị thành 5 tab (có skeleton khi đang tải). Nếu AI lỗi hoặc bị giới hạn lượt gọi (429), app tự dùng 5 tab mặc định: Đời sống, Công sở, Trường học, Mạng xã hội, Tự do.
2. Mỗi tab tự sinh một câu mẫu kèm bản dịch; nút "Đổi câu mẫu" sinh câu khác. Các nút bị khóa tạm thời trong lúc gọi API để tránh spam.
3. Bấm "Xác nhận" để Gemini chấm điểm /100, sửa ngữ pháp, nhận xét bằng tiếng Việt và gợi ý cách nói tự nhiên hơn. Nếu AI không phản hồi, app chấm nhanh offline.

Tất cả lượt gọi đi qua Netlify Function `/api/ai/context-practice`, nên API key không bao giờ lộ ra trình duyệt.

## Trợ Lý Đo Nhịp Trí Nhớ

Mở từ tab **Thống kê** hoặc thanh điều hướng. Trợ lý:

1. Đo nhịp nhớ thật của bạn: tỷ lệ nhớ khi ôn lại (chỉ tính các lượt ôn thẻ đã có lịch hẹn; Hard/Good/Easy = nhớ, Again = quên), số thẻ ôn mỗi ngày trong 30 ngày qua và tiến độ tới mốc 1.000 lượt.
2. Cho bạn chọn phong cách học (thi cấp tốc / bền vững / theo sở thích).
3. Đề xuất ngay mức ghi nhớ mục tiêu kèm ước tính số thẻ phải ôn mỗi ngày tăng/giảm bao nhiêu, và lý do cụ thể. Nút "Nhờ AI giải thích thêm" gọi `/api/ai/optimize-fsrs` để Gemini viết lời khuyên; con số đề xuất luôn được tính bằng cùng một quy tắc (`src/utils/memoryRhythm.ts`) trên cả trình duyệt và server.

### Cài đặt FSRS cá nhân

Trong trợ lý → mục **3. Cài Đặt Thuật Toán FSRS**:

- **Tập tham số riêng (Weights):** mặc định dùng bộ tiêu chuẩn của ts-fsrs (21 tham số). Từ 400 lượt ôn (khuyến nghị 1.000), bấm tối ưu để phân tích lịch sử học ngay trên trình duyệt và áp dụng bộ tham số riêng (có thể quay về bộ tiêu chuẩn).
- **Tỷ lệ ghi nhớ mục tiêu:** 80%–95%. Cao hơn → ôn dày hơn; 80–85% → khoảng cách dài hơn, tiết kiệm thời gian.
- **Khoảng cách tối đa:** 180 / 365 / 1.000 / 3.650 ngày hoặc tự nhập (mặc định 365).
- **Bước học ban đầu:** bật/tắt các bước ngắn (vd `10m 30m`) cho thẻ mới trước khi chuyển sang lịch theo ngày.

Mọi thay đổi trong trợ lý chỉ được áp dụng khi bấm **Lưu cài đặt** ở cuối cửa sổ (có nút Hoàn tác và nhắc nhở khi đóng mà chưa lưu). Cài đặt được lưu vào tài khoản nên dùng chung trên mọi thiết bị.

## Chạy ở local

**Yêu cầu:** Node.js

1. Cài dependencies:
   ```
   npm install
   ```
2. Sao chép `.env.example` thành `.env.local` và điền `GEMINI_API_KEY` nếu muốn dùng tính năng AI (không bắt buộc, có fallback offline).
3. Chạy app:
   ```
   npm run dev
   ```

## Deploy

Dự án giữ các Netlify Functions cũ để tương thích, nhưng có thể deploy frontend + `/api/ai/*` trên Vercel:

- `npm run build` build ra `dist/`.
- `api/ai/*.ts` là các Vercel API Routes xử lý AI lookup, luyện 5 ngữ cảnh và tối ưu FSRS.
- Dữ liệu ứng dụng chính nằm trong Supabase; migration ở `supabase/migrations/`.

## Xác thực & Dữ liệu theo tài khoản

- Đăng nhập bằng Email/Mật khẩu qua Supabase (chỉ dùng để xác thực).
- Từ vựng, ngữ pháp, tiến độ FSRS, cài đặt, Rank/chuỗi lửa, huy hiệu game và lịch sử ôn được lưu trong Netlify Database qua API có xác thực `/api/data`; máy chủ chỉ đọc/ghi dữ liệu của đúng tài khoản.
- Lần đầu đăng nhập sau cập nhật, dữ liệu cũ (bảng Supabase trước đây và bản lưu trên máy) được tự chuyển vào tài khoản.
- Mất mạng: thay đổi được giữ trên máy và tự gửi khi có mạng; góc trên hiển thị “Đang chờ mạng” cùng số thay đổi đang chờ.
- Thay đổi từ thiết bị khác được cập nhật mỗi 15 giây, khi quay lại tab hoặc khi có mạng lại.
- Bản sao trên máy gắn với một tài khoản; đăng xuất sẽ gửi nốt thay đổi (cảnh báo nếu chưa gửi được) rồi xóa bản sao trên máy.


### Gemini text model fallback
Text AI uses `gemini-3.5-flash-lite` first and automatically falls back to `gemini-3.1-flash-lite` when the primary model hits quota/rate limits or temporary unavailability.


## Vercel AI note
The AI routes under /api/ai are intended for Vercel. The fallback order is gemini-3.5-flash-lite -> gemini-3.1-flash-lite. A quota error is returned as HTTP 429 instead of being masked by a secondary exception.
.
