# Batch AI for Output 5 ngữ cảnh

Khi mở modal Luyện Output 5 ngữ cảnh, app gọi `/api/ai/context-practice` đúng **1 request** với action `batchPractice`.

Gemini trả về cùng lúc:
- 5 ngữ cảnh
- 5 câu mẫu tham khảo (1 câu cho mỗi ngữ cảnh)

Chuyển tab chỉ đọc dữ liệu đã nhận, **không gọi Gemini thêm**.

Nút "Đổi câu mẫu" vẫn thực hiện 1 request riêng cho ngữ cảnh đang xem.

Nút "Xác nhận lần X" vẫn gọi 1 request riêng để chấm câu của người dùng.

Model text hiện tại trong project: `gemini-3.5-flash-lite`.


## Model fallback
The batch 5-context request uses `gemini-3.5-flash-lite` first and automatically falls back to `gemini-3.1-flash-lite` when needed. One request still returns all 5 contexts and 5 reference sentences.
