import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import axios from 'axios'

export const useAuthStore = defineStore('auth', () => {
  const router = useRouter()
  const token = ref(localStorage.getItem('token'))
  const phone = ref(localStorage.getItem('phone'))  // 新增 phone 状态
  const username = ref(localStorage.getItem('username'))
  const role = ref(localStorage.getItem('role'))
  const errorMessage = ref('')
  const isLoading = ref(false)

  const isAuthenticated = computed(() => !!token.value)

  const login = async (phoneInput, password) => {
    isLoading.value = true
    errorMessage.value = ''
    
    try {
      const response = await axios.post('/api/auth/login', {
        phone: phoneInput,
        password
      })

      if (response.data.success) {
        token.value = response.data.token
        phone.value = phoneInput  // 存储手机号
        username.value = response.data.username  // 存储用户名
        role.value = response.data.role
        localStorage.setItem('token', token.value)
        localStorage.setItem('phone', phone.value)  // 存储到本地
        localStorage.setItem('username', username.value)  // 存储用户名
        localStorage.setItem('role', role.value)
        
        // 更新axios默认headers
        axios.defaults.headers.common['Authorization'] = `Bearer ${token.value}`
        
        const redirect = router.currentRoute.value.query.redirect || '/tools'
        router.push(redirect)
      }
      
      return response.data
    } catch (error) {
      errorMessage.value = error.response?.data?.message || '登录失败，请检查网络连接'
      throw error
    } finally {
      isLoading.value = false
    }
  }

  const logout = () => {
    token.value = null
    phone.value = null  // 清除手机号
    role.value = null
    localStorage.removeItem('token')
    localStorage.removeItem('phone')  // 清除本地存储
    localStorage.removeItem('role')
    localStorage.removeItem('username')  // 清除用户名
    delete axios.defaults.headers.common['Authorization']
    router.push('/login')
  }

  const init = () => {
    token.value = localStorage.getItem('token')
    phone.value = localStorage.getItem('phone')  // 初始化时加载
    role.value = localStorage.getItem('role')
    username.value = localStorage.getItem('username')  // 初始化时加载用户名
    
    if (token.value) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${token.value}`
    }
  }

  init()

  return {
    token,
    phone,  // 导出 phone
    username,
    role,
    errorMessage,
    isLoading,
    isAuthenticated,
    login,
    logout,
    init
  }
})