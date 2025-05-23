import { defineStore } from 'pinia';
import api from '@/api';

export const useDatabaseStore = defineStore('database', {
  state: () => ({
    stats: {
      activeAddresses: 0,
      prefixes: 0,
      countries: 0,
      asns: 0,
      vulnerabilities: 0
    },
    isLoading: false,
    error: null
  }),
  
  actions: {
    async fetchDatabaseStats() {
      try {
        this.isLoading = true;
        const response = await api.database.getStats();
        this.stats = response.data;
      } catch (error) {
        console.error('获取数据库统计信息失败:', error);
        this.error = error.message;
      } finally {
        this.isLoading = false;
      }
    },
    
    async importAddresses(importData) {
      try {
        this.isLoading = true;
        const response = await api.database.importAddresses(importData);
        await this.fetchDatabaseStats();
        return response.data;
      } catch (error) {
        console.error('导入地址失败:', error);
        this.error = error.message;
        throw error;
      } finally {
        this.isLoading = false;
      }
    },
    
    async updateVulnerabilities(vulnerabilityData) {
      try {
        this.isLoading = true;
        const response = await api.database.updateVulnerabilities(vulnerabilityData);
        await this.fetchDatabaseStats();
        return response.data;
      } catch (error) {
        console.error('更新漏洞信息失败:', error);
        this.error = error.message;
        throw error;
      } finally {
        this.isLoading = false;
      }
    },
    
    async updateProtocolSupport(protocolData) {
      try {
        this.isLoading = true;
        const response = await api.database.updateProtocolSupport(protocolData);
        await this.fetchDatabaseStats();
        return response.data;
      } catch (error) {
        console.error('更新协议支持信息失败:', error);
        this.error = error.message;
        throw error;
      } finally {
        this.isLoading = false;
      }
    },
    
    async performAdvancedQuery(queryParams) {
      try {
        this.isLoading = true;
        console.log('发送高级查询请求:', JSON.stringify(queryParams, null, 2));
        const response = await api.database.advancedQuery(queryParams);
        console.log('高级查询响应:', response);
        
        if (response.data && response.data.data) {
          console.log(`查询成功，返回 ${response.data.data.length} 条记录`);
          if (response.data.data.length === 0) {
            console.log('查询结果为空，没有符合条件的数据');
          }
        } else {
          console.warn('查询响应格式异常:', response.data);
        }
        
        return response.data;
      } catch (error) {
        console.error('执行高级查询失败:', error);
        console.error('错误详情:', error.response ? error.response.data : '无响应数据');
        this.error = error.message;
        throw error;
      } finally {
        this.isLoading = false;
      }
    },
    
    async getCountryStats() {
      try {
        const response = await api.database.getCountryStats();
        return response.data;
      } catch (error) {
        console.error('获取国家统计信息失败:', error);
        this.error = error.message;
        return [];
      }
    },
    
    async getVulnerabilityStats() {
      try {
        const response = await api.database.getVulnerabilityStats();
        return response.data;
      } catch (error) {
        console.error('获取漏洞统计信息失败:', error);
        this.error = error.message;
        return [];
      }
    },

    //IID更新
    async updateIIDTypes(iidTypeData) {
      try {
        this.isLoading = true;
        const response = await api.database.updateIIDTypes(iidTypeData);
        await this.fetchDatabaseStats();
        return response.data;  // 注意这里返回的是 response.data
      } catch (error) {
        console.error('更新IID类型信息失败:', error);
        this.error = error.message;
        throw error;
      } finally {
        this.isLoading = false;
      }
    },
    
    // 获取 IID 类型列表
    async getIIDTypes() {
      try {
        const response = await api.database.getIIDTypes();
        return response.data;
      } catch (error) {
        console.error('获取IID类型列表失败:', error);
        this.error = error.message;
        return [];
      }
    }
    
  },

});