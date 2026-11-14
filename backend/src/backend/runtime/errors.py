class AppError(Exception):
    def __init__(self, code: str, message: str, status: int = 422, *, image_index: int | None = None):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status
        self.image_index = image_index


def unavailable() -> AppError:
    return AppError("storage_unavailable", "Chưa kết nối được kho dữ liệu. Vui lòng thử lại.", 503)
