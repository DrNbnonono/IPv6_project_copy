const db = require('../database/db');
const addressModel = require('../models/addressModels');
const { createLogger, transports } = require('winston');
const fs = require('fs');
const readline = require('readline');

// 配置日志
const logger = createLogger({
  transports: [new transports.Console()]
});

/**
 * 获取数据库统计信息
 */
exports.getDatabaseStats = async (req, res) => {
  try {
    // 获取活跃地址数量
    const [[activeAddresses]] = await db.query(`
      SELECT COUNT(*) as count FROM active_addresses
    `);

    // 获取前缀数量
    const [[prefixes]] = await db.query(`
      SELECT COUNT(*) as count FROM ip_prefixes
    `);

    // 获取国家数量
    const [[countries]] = await db.query(`
      SELECT COUNT(*) as count FROM countries
    `);

    // 获取ASN数量
    const [[asns]] = await db.query(`
      SELECT COUNT(*) as count FROM asns
    `);

    // 获取漏洞数量
    const [[vulnerabilities]] = await db.query(`
      SELECT COUNT(*) as count FROM vulnerabilities
    `);

    res.json({
      success: true,
      activeAddresses: activeAddresses.count,
      prefixes: prefixes.count,
      countries: countries.count,
      asns: asns.count,
      vulnerabilities: vulnerabilities.count
    });
  } catch (error) {
    logger.error('获取数据库统计信息失败:', error);
    res.status(500).json({
      success: false,
      message: '获取数据库统计信息失败'
    });
  }
};

/**
 * 导入IPv6地址
 */
exports.importAddresses = async (req, res) => {
  try {
    console.log('接收到导入请求:', JSON.stringify({
      countryId: req.body.countryId,
      asn: req.body.asn,
      prefix: req.body.prefix,
      addressCount: req.body.addresses ? req.body.addresses.length : 0
    }));
    
    // 验证必要参数
    if (!req.body.countryId || !req.body.asn || !req.body.prefix || !req.body.addresses || !Array.isArray(req.body.addresses)) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数或参数格式不正确'
      });
    }
    
    // 开始事务
    await db.query('START TRANSACTION');
    
    // 创建临时表
    await db.query(`
      CREATE TEMPORARY TABLE temp_addresses (
        address VARCHAR(128) NOT NULL,
        is_processed BOOLEAN DEFAULT FALSE,
        PRIMARY KEY (address)
      )
    `);
    
    // 批量插入地址到临时表
    const insertValues = req.body.addresses.map(addr => [addr]);
    if (insertValues.length > 0) {
      await db.query(`
        INSERT INTO temp_addresses (address) VALUES ?
      `, [insertValues]);
    }
    
    // 调用存储过程 - 分两步执行
    // 1. 首先设置输出变量
    await db.query(`SET @imported = 0, @errors = 0`);
    
    // 2. 调用存储过程
    await db.query(`
      CALL batch_import_ipv6_addresses(?, ?, ?, @imported, @errors)
    `, [req.body.countryId, req.body.asn, req.body.prefix]);
    
    // 3. 单独查询输出变量的值
    const [resultSet] = await db.query(`
      SELECT @imported as imported_count, @errors as error_count
    `);
    
    // 获取导入结果
    const result = resultSet[0];
    
    // 提交事务
    await db.query('COMMIT');
    
    // 返回结果
    res.json({
      success: true,
      message: `成功导入${result.imported_count}个IPv6地址`,
      importedCount: result.imported_count,
      errorCount: result.error_count
    });
    
  } catch (error) {
    // 回滚事务
    try {
      await db.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('回滚事务失败:', rollbackError);
    }
    
    logger.error('导入地址过程中发生错误:', error);
    res.status(500).json({
      success: false,
      message: `导入地址失败: ${error.message}`
    });
  } finally {
    // 确保清理临时表
    try {
      await db.query('DROP TEMPORARY TABLE IF EXISTS temp_addresses');
    } catch (cleanupError) {
      console.error('清理临时表失败:', cleanupError);
    }
  }
};

/**
 * 更新漏洞状态
 */
exports.updateVulnerabilities = async (req, res) => {
  console.log('--- Entered updateVulnerabilities function ---'); // 确认函数入口
  console.log('Request body:', JSON.stringify(req.body)); // 记录请求体
  const { vulnerabilityId, countryId, asn, isFixed, addresses } = req.body;

  // 1. 验证输入参数
  if (!vulnerabilityId) {
    logger.warn('更新漏洞状态请求缺少 vulnerabilityId'); // 添加参数验证日志
    return res.status(400).json({ success: false, message: '缺少漏洞ID' });
  }
  if (!countryId && !asn) {
     logger.warn('更新漏洞状态请求缺少 countryId 或 asn');
    return res.status(400).json({ success: false, message: '至少需要提供一个筛选条件(国家ID或ASN)' });
  }
  if (typeof isFixed === 'undefined' || isFixed === null) {
     logger.warn('更新漏洞状态请求缺少 isFixed');
     return res.status(400).json({ success: false, message: '缺少漏洞修复状态(isFixed)' });
  }
  if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
     logger.warn('更新漏洞状态请求缺少有效的 addresses 列表');
    return res.status(400).json({ success: false, message: '缺少有效的IPv6地址列表' });
  }

  let connection;
  try {
    console.log('尝试获取数据库连接...');
    connection = await db.getConnection();
    console.log('数据库连接获取成功，开始事务...');
    await connection.beginTransaction();
    console.log('事务已开始');

    // 2. 检查漏洞ID是否存在
    console.log(`检查漏洞ID ${vulnerabilityId} 是否存在...`);
    const [vulnRows] = await connection.query(
      'SELECT vulnerability_id FROM vulnerabilities WHERE vulnerability_id = ?',
      [vulnerabilityId]
    );
    if (vulnRows.length === 0) {
      logger.warn(`尝试更新不存在的漏洞ID: ${vulnerabilityId}`);
      await connection.rollback();
      connection.release(); // 释放连接
      return res.status(400).json({ success: false, message: `指定的漏洞ID ${vulnerabilityId} 不存在` });
    }
    console.log(`漏洞ID ${vulnerabilityId} 存在`);

    // 3. 准备临时表
    console.log('准备临时表 temp_address_list...');
    await connection.query(`
      CREATE TEMPORARY TABLE IF NOT EXISTS temp_address_list (
        address VARCHAR(128) NOT NULL,
        PRIMARY KEY (address)
      )
    `);
    console.log('临时表已确保存在，清空临时表...');
    await connection.query(`TRUNCATE TABLE temp_address_list`);
    console.log('临时表已清空');

    // 插入地址到临时表
    const addressValues = addresses.map(addr => [addr]);
    console.log(`准备向临时表插入 ${addressValues.length} 条地址...`);
    await connection.query(`
      INSERT IGNORE INTO temp_address_list (address) VALUES ?
    `, [addressValues]);
    console.log('地址已插入临时表 (忽略重复)');

    // 检查是否有数据插入临时表
    const [insertedCount] = await connection.query(`
      SELECT COUNT(*) as count FROM temp_address_list
    `);
    console.log(`临时表数据插入结果: 已插入 ${insertedCount[0].count} 条唯一地址，原始地址列表长度: ${addresses.length}`);
    if (insertedCount[0].count === 0) {
       logger.warn('提供的地址列表无效或格式不正确，未能向临时表插入任何数据');
      await connection.rollback();
      connection.release();
      return res.status(400).json({
        success: false,
        message: '提供的地址列表无效或格式不正确，无法插入临时表'
      });
    }

    // 4. 调用存储过程
    console.log('设置存储过程输出变量 @affected_rows = 0...');
    await connection.query(`SET @affected_rows = 0`);
    console.log('准备调用存储过程 update_vulnerability_status...');
    console.log(`存储过程参数: vulnerabilityId=${vulnerabilityId}, countryId=${countryId || null}, asn=${asn || null}, isFixed=${isFixed ? 1 : 0}`);

    try {
      await connection.query(
        'CALL update_vulnerability_status(?, ?, ?, ?, @affected_rows)',
        [
          vulnerabilityId,
          countryId || null,
          asn || null,
          isFixed ? 1 : 0
        ]
      );
      console.log('存储过程调用成功');

      // 获取输出参数的值
      console.log('获取存储过程输出变量 @affected_rows...');
      const [result] = await connection.query('SELECT @affected_rows AS affectedRows');
      const affectedRows = result[0].affectedRows;
      console.log(`存储过程影响行数: ${affectedRows}`);

      // 5. 提交事务
      console.log('准备提交事务...');
      await connection.commit();
      console.log('事务已提交');

      res.json({
        success: true,
        message: `成功更新 ${affectedRows} 条地址的漏洞状态`,
        affectedRows: affectedRows
      });

    } catch (procError) {
      // 优先捕获存储过程SIGNAL的错误
      console.error('!!! 调用存储过程 update_vulnerability_status 失败 !!!'); // 添加显式错误标记
      logger.error('调用存储过程 update_vulnerability_status 失败详情:', procError); // <--- 记录存储过程错误
      console.log('准备回滚事务...');
      await connection.rollback(); // 回滚事务
      console.log('事务已回滚');
      // 尝试解析存储过程返回的错误信息
      const procedureErrorMessage = procError.message.includes('SQLSTATE 45000')
        ? procError.message.substring(procError.message.indexOf('MESSAGE_TEXT = \'') + 16, procError.message.lastIndexOf('\''))
        : `更新漏洞状态时发生数据库错误: ${procError.message}`;
      console.error(`解析后的存储过程错误信息: ${procedureErrorMessage}`);

      return res.status(500).json({
        success: false,
        message: procedureErrorMessage
      });
    }

  } catch (error) {
    // 处理获取连接、事务、准备临时表等过程中的错误
    console.error('!!! 更新漏洞状态操作中发生未预期的错误 !!!'); // 添加显式错误标记
    logger.error('更新漏洞状态操作失败详情:', error); // <--- 记录其他操作错误
    if (connection) {
      try {
        console.log('尝试回滚事务...');
        await connection.rollback(); // 确保回滚
        console.log('事务已回滚');
      } catch (rollbackError) {
        logger.error('回滚事务失败:', rollbackError);
      }
    }
    res.status(500).json({
      success: false,
      message: `服务器内部错误: ${error.message}`
    });
  } finally {
    // 6. 清理资源
    if (connection) {
      try {
        console.log('准备清理临时表 temp_address_list...');
        await connection.query('DROP TEMPORARY TABLE IF EXISTS temp_address_list');
        console.log('临时表 temp_address_list 已清理');
      } catch (cleanupError) {
        logger.error('清理临时表 temp_address_list 失败:', cleanupError); // <--- 记录清理错误
      } finally {
         console.log('准备释放数据库连接...');
         connection.release(); // 确保连接被释放回池中
         console.log('数据库连接已释放');
      }
    } else {
        console.log('无需释放数据库连接 (可能获取连接失败)');
    }
     console.log('--- Exiting updateVulnerabilities function ---'); // 确认函数出口
  }
};

/**
 * 更新协议支持
 */
exports.updateProtocolSupport = async (req, res) => {
  try {
    const { protocolId, countryId, asn, port, addresses } = req.body;
    
    if (!protocolId) {
      return res.status(400).json({ success: false, message: '缺少协议ID' });
    }
    
    if (!countryId && !asn) {
      return res.status(400).json({ success: false, message: '至少需要提供一个筛选条件(国家ID或ASN)' });
    }
    
    if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
      return res.status(400).json({ success: false, message: '缺少IPv6地址列表' });
    }
    
    const connection = await db.getConnection();
    await connection.beginTransaction();
    
    try {
      // 创建临时表存储地址列表
      await connection.query(`
        CREATE TEMPORARY TABLE IF NOT EXISTS temp_address_list (
          address VARCHAR(128) NOT NULL,
          PRIMARY KEY (address)
        )
      `);

      // 检查临时表是否存在
      const [tempTableExists] = await connection.query(`
        SELECT COUNT(*) FROM temp_address_list 
      `);
      
      console.log('临时表检查结果:', tempTableExists[0].count > 0 ? '存在' : '不存在');
      
      
      // 清空临时表
      await connection.query(`TRUNCATE TABLE temp_address_list`);
      
      // 插入地址到临时表
      const addressValues = addresses.map(addr => [addr]);
      await connection.query(`
        INSERT IGNORE INTO temp_address_list (address) VALUES ?
      `, [addressValues]);
      
      // 调用存储过程更新协议支持
      const [result] = await connection.query(`
        CALL update_protocol_support(?, ?, ?, ?, ?, @affected_rows)
      `, [
        protocolId,
        countryId || null,
        asn || null,
        port || null,
        1, // is_supported
      ]);
      
      // 获取受影响的行数
      const [rows] = await connection.query(`SELECT @affected_rows as affected_rows`);
      const affectedRows = rows[0].affected_rows;
      
      // 清理临时表
      await connection.query(`DROP TEMPORARY TABLE IF EXISTS temp_address_list`);
      
      await connection.commit();
      
      return res.json({
        success: true,
        message: `成功更新${affectedRows}个IPv6地址的协议支持状态`,
        data: { affectedRows }
      });
    } catch (error) {
      await connection.rollback();
      console.error('更新协议支持状态失败:', error);
      return res.status(500).json({ success: false, message: `更新协议支持状态失败: ${error.message}` });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('更新协议支持状态失败:', error);
    return res.status(500).json({ success: false, message: `更新协议支持状态失败: ${error.message}` });
  }
};

/**
 * 执行高级查询
 */
exports.advancedQuery = async (req, res) => {
  try {
    // 打印接收到的请求体
    console.log('高级查询接收到的请求体:', JSON.stringify(req.body, null, 2));
    
    const query = req.body.query || req.body.sql;
    const params = req.body.params || [];
    
    if (!query) {
      console.log('错误: 缺少查询语句');
      return res.status(400).json({
        success: false,
        message: '缺少查询语句'
      });
    }

    // 验证查询语句，防止SQL注入
    if (!isValidSqlQuery(query)) {
      console.log('错误: 无效的查询语句:', query);
      return res.status(400).json({
        success: false,
        message: '无效的查询语句'
      });
    }

    // 打印将要执行的SQL和参数
    console.log('执行SQL查询:', query);
    console.log('查询参数:', params);

    // 执行查询
    const [results] = await db.query(query, params);
    
    // 打印查询结果的行数
    console.log(`查询完成，返回 ${results.length} 条记录`);
    
    // 如果结果为空，打印提示信息
    if (results.length === 0) {
      console.log('查询结果为空，没有符合条件的数据');
    } else {
      // 打印第一条记录的结构（不打印具体内容以避免日志过大）
      console.log('结果第一条记录的字段:', Object.keys(results[0]));
    }

    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    logger.error(`高级查询失败: ${error.message}`);
    console.error('高级查询执行错误:', error);
    console.error('错误堆栈:', error.stack);
    res.status(500).json({
      success: false,
      message: `查询失败: ${error.message}`
    });
  }
};

/**
 * 获取国家统计信息
 */
exports.getCountryStats = async (req, res) => {
  try {
    const [results] = await db.query(`
      SELECT * FROM country_ipv6_stats_view
    `);

    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    logger.error('获取国家统计信息失败:', error);
    res.status(500).json({
      success: false,
      message: '获取国家统计信息失败'
    });
  }
};

/**
 * 获取漏洞统计信息
 */
exports.getVulnerabilityStats = async (req, res) => {
  try {
    const [results] = await db.query(`
      SELECT * FROM vulnerability_stats_view
    `);

    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    logger.error('获取漏洞统计信息失败:', error);
    res.status(500).json({
      success: false,
      message: '获取漏洞统计信息失败'
    });
  }
};

/**
 * 批量删除IPv6地址
 */
exports.deleteAddresses = async (req, res) => {
  try {
    const { addressIds } = req.body;
    
    if (!addressIds || !Array.isArray(addressIds) || addressIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: '缺少要删除的地址ID列表'
      });
    }

    // 开始事务
    await db.query('START TRANSACTION');

    // 获取地址所属的国家和ASN信息
    const [addressInfo] = await db.query(`
      SELECT 
        aa.address_id,
        ip.country_id,
        ip.asn
      FROM 
        active_addresses aa
      JOIN 
        ip_prefixes ip ON aa.prefix_id = ip.prefix_id
      WHERE 
        aa.address_id IN (?)
    `, [addressIds]);

    // 删除地址
    const [deleteResult] = await db.query(`
      DELETE FROM active_addresses 
      WHERE address_id IN (?)
    `, [addressIds]);

    // 更新国家统计信息
    const countryUpdates = {};
    addressInfo.forEach(info => {
      if (!countryUpdates[info.country_id]) {
        countryUpdates[info.country_id] = true;
      }
    });

    for (const countryId of Object.keys(countryUpdates)) {
      await db.query(`
        UPDATE countries 
        SET 
          total_active_ipv6 = (
            SELECT COUNT(*) FROM active_addresses aa
            JOIN ip_prefixes ip ON aa.prefix_id = ip.prefix_id
            WHERE ip.country_id = ?
          ),
          last_updated = NOW()
        WHERE country_id = ?
      `, [countryId, countryId]);
    }

    // 更新ASN统计信息
    const asnUpdates = {};
    addressInfo.forEach(info => {
      if (!asnUpdates[info.asn]) {
        asnUpdates[info.asn] = true;
      }
    });

    for (const asn of Object.keys(asnUpdates)) {
      await db.query(`
        UPDATE asns
        SET 
          total_active_ipv6 = (
            SELECT COUNT(*) FROM active_addresses aa
            JOIN ip_prefixes ip ON aa.prefix_id = ip.prefix_id
            WHERE ip.asn = ?
          ),
          last_updated = NOW()
        WHERE asn = ?
      `, [asn, asn]);
    }

    // 提交事务
    await db.query('COMMIT');

    res.json({
      success: true,
      message: `成功删除${deleteResult.affectedRows}个IPv6地址`,
      deletedCount: deleteResult.affectedRows
    });
  } catch (error) {
    // 回滚事务
    await db.query('ROLLBACK');
    logger.error('删除地址失败:', error);
    res.status(500).json({
      success: false,
      message: `删除地址失败: ${error.message}`
    });
  }
};

/**
 * 获取漏洞类型列表
 */
exports.getVulnerabilityTypes = async (req, res) => {
  try {
    const [results] = await db.query('SELECT * FROM vulnerabilities');
    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    logger.error('获取漏洞类型失败:', error);
    res.status(500).json({
      success: false,
      message: '获取漏洞类型失败'
    });
  }
};

/**
 * 获取协议类型列表
 */
exports.getProtocolTypes = async (req, res) => {
  try {
    const [results] = await db.query('SELECT * FROM protocols');
    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    logger.error('获取协议类型失败:', error);
    res.status(500).json({
      success: false,
      message: '获取协议类型失败'
    });
  }
};

// 辅助函数：验证SQL查询语句
function isValidSqlQuery(query) {
  // 只允许SELECT查询
  if (!query.trim().toUpperCase().startsWith('SELECT')) {
    return false;
  }

  // 禁止危险操作
  const forbiddenKeywords = ['DROP', 'TRUNCATE', 'DELETE', 'UPDATE', 'INSERT', 'CREATE', 'ALTER', 'GRANT', 'REVOKE'];
  const upperQuery = query.toUpperCase();
  for (const keyword of forbiddenKeywords) {
    if (upperQuery.includes(keyword)) {
      return false;
    }
  }

  return true;
}

/**
 * 获取特定国家的ASN列表
 */
exports.getAsnsByCountry = async (req, res) => {
  try {
    const countryId = req.params.countryId;
    
    // 验证国家ID
    if (!countryId || countryId.length !== 2) {
      return res.status(400).json({
        success: false,
        message: '无效的国家ID'
      });
    }
    
    // 查询特定国家的ASN
    const [results] = await db.query(`
      SELECT DISTINCT a.asn, a.as_name, a.as_name_zh, a.country_id
      FROM asns a
      JOIN ip_prefixes ip ON a.asn = ip.asn
      WHERE ip.country_id = ?
      ORDER BY a.as_name_zh
    `, [countryId]);
    
    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    logger.error(`获取国家 ${req.params.countryId} 的ASN列表失败:`, error);
    res.status(500).json({
      success: false,
      message: '获取ASN列表失败'
    });
  }
};

/**
 * 获取特定ASN的前缀列表
 */
exports.getPrefixesByAsn = async (req, res) => {
  try {
    const asn = req.params.asn;
    
    // 验证ASN
    if (!asn || isNaN(parseInt(asn))) {
      return res.status(400).json({
        success: false,
        message: '无效的ASN'
      });
    }
    
    // 查询特定ASN的前缀
    const [results] = await db.query(`
      SELECT prefix_id, prefix, country_id, asn, version, prefix_length
      FROM ip_prefixes
      WHERE asn = ?
      ORDER BY prefix
    `, [asn]);
    
    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    logger.error(`获取ASN ${req.params.asn} 的前缀列表失败:`, error);
    res.status(500).json({
      success: false,
      message: '获取前缀列表失败'
    });
  }
};



/**
 * 搜索ASN
 */
exports.searchAsns = async (req, res) => {
  try {
    const query = req.query.query || '';
    const limit = parseInt(req.query.limit) || 10;
    
    if (!query) {
      return res.json({
        success: true,
        data: []
      });
    }
    
    // 搜索ASN
    const [results] = await db.query(`
      SELECT asn, as_name, as_name_zh, country_id
      FROM asns
      WHERE 
        asn LIKE ? OR
        as_name LIKE ? OR
        as_name_zh LIKE ?
      ORDER BY 
        CASE 
          WHEN asn = ? THEN 0
          WHEN asn LIKE ? THEN 1
          ELSE 2
        END,
        as_name_zh
      LIMIT ?
    `, [`%${query}%`, `%${query}%`, `%${query}%`, query, `${query}%`, limit]);
    
    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    logger.error('搜索ASN失败:', error);
    res.status(500).json({
      success: false,
      message: '搜索ASN失败'
    });
  }
};

/**
 * 搜索前缀
 */
exports.searchPrefixes = async (req, res) => {
  try {
    const query = req.query.query || '';
    const limit = parseInt(req.query.limit) || 10;
    
    if (!query) {
      return res.json({
        success: true,
        data: []
      });
    }
    
    // 搜索前缀
    const [results] = await db.query(`
      SELECT prefix_id, prefix, country_id, asn, version, prefix_length
      FROM ip_prefixes
      WHERE prefix LIKE ?
      ORDER BY 
        CASE 
          WHEN prefix = ? THEN 0
          WHEN prefix LIKE ? THEN 1
          ELSE 2
        END,
        prefix
      LIMIT ?
    `, [`%${query}%`, query, `${query}%`, limit]);
    
    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    logger.error('搜索前缀失败:', error);
    res.status(500).json({
      success: false,
      message: '搜索前缀失败'
    });
  }
};

// 获取IID类型列表
exports.getIIDTypes = async (req, res) => {
  try {
    const connection = await pool.getConnection();
    
    const [rows] = await connection.query(`
      SELECT 
        type_id, 
        type_name, 
        description, 
        is_risky, 
        example
      FROM 
        address_types
      ORDER BY 
        type_name
    `);
    
    connection.release();
    
    res.json({
      success: true,
      data: rows
    });
  } catch (error) {
    console.error('获取IID类型失败:', error);
    res.status(500).json({
      success: false,
      message: '获取IID类型失败',
      error: error.message
    });
  }
};



/**
 * 获取地址类型列表
 */
exports.getAddressTypes = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        type_id, 
        type_name, 
        description, 
        is_risky, 
        example
      FROM 
        address_types
      ORDER BY 
        type_name
    `);
    
    res.json({
      success: true,
      data: rows
    });
  } catch (error) {
    logger.error('获取地址类型失败:', error);
    res.status(500).json({
      success: false,
      message: '获取地址类型失败',
      error: error.message
    });
  }
};

/**
 * 更新地址 IID 类型
 */
exports.updateIIDTypes = async (req, res) => {
  const { iidTypeId, isDetected, countryId, asn, addresses } = req.body;
  
  if (!iidTypeId || !addresses || !Array.isArray(addresses) || addresses.length === 0) {
    return res.status(400).json({
      success: false,
      message: '参数错误: 缺少必要参数或地址列表为空'
    });
  }
  
  let connection;
  try {
    // 获取数据库连接
    connection = await db.getConnection();
    await connection.beginTransaction();
    
    // 创建临时表存储地址列表
    await connection.query(`
      CREATE TEMPORARY TABLE IF NOT EXISTS temp_address_list (
        address VARCHAR(128) NOT NULL,
        PRIMARY KEY (address)
      )
    `);
    
    // 清空临时表
    await connection.query(`TRUNCATE TABLE temp_address_list`);
    
    // 插入地址到临时表
    const addressValues = addresses.map(addr => [addr]);
    await connection.query(`
      INSERT IGNORE INTO temp_address_list (address) VALUES ?
    `, [addressValues]);
    
    // 调用存储过程更新IID类型
    await connection.query(`SET @updated_count = 0, @inserted_count = 0, @skipped_count = 0, @total_count = 0`);
    await connection.query(`
      CALL update_address_iid_types(?, ?, ?, ?, @updated_count, @inserted_count, @skipped_count, @total_count)
    `, [
      iidTypeId,
      isDetected ? 1 : 0,
      countryId || null,
      asn || null
    ]);
    
    // 获取统计结果
    const [stats] = await connection.query(`
      SELECT 
        @updated_count AS updated_count, 
        @inserted_count AS inserted_count, 
        @skipped_count AS skipped_count, 
        @total_count AS total_addresses
    `);
    
    // 清理临时表
    await connection.query(`DROP TEMPORARY TABLE IF EXISTS temp_address_list`);
    
    await connection.commit();
    
    res.json({
      success: true,
      message: `成功处理${stats[0].total_addresses}个地址的IID类型`,
      data: {
        total: stats[0].total_addresses,
        updated: stats[0].updated_count,
        inserted: stats[0].inserted_count,
        skipped: stats[0].skipped_count
      }
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    logger.error('更新IID类型失败:', error);
    res.status(500).json({
      success: false,
      message: '更新IID类型失败',
      error: error.message
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};