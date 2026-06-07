import axios from 'axios'

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '',
  withCredentials: true,
  // JANGAN hard-code Content-Type: axios otomatis pakai application/json untuk body objek
  // dan multipart/form-data (+boundary) untuk FormData. Default JSON yang dipaksa membuat
  // upload file (FormData) terkirim sebagai application/json tanpa boundary → 422.
})

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      if (window.location.pathname.startsWith('/admin')) {
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  },
)

export default apiClient
