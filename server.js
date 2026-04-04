const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// LOG DAS VARIÁVEIS DE AMBIENTE
console.log('\n🔍 VERIFICANDO CONFIGURAÇÃO:');
console.log('DB_HOST:', process.env.DB_HOST || '❌ NÃO DEFINIDO');
console.log('DB_USER:', process.env.DB_USER || '❌ NÃO DEFINIDO');
console.log('DB_NAME:', process.env.DB_NAME || '❌ NÃO DEFINIDO');
console.log('DB_PORT:', process.env.DB_PORT || '❌ NÃO DEFINIDO');
console.log('JWT_SECRET:', process.env.JWT_SECRET ? '✅ DEFINIDO' : '❌ NÃO DEFINIDO');

// Configuração do MySQL
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'nosso_clube_db',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    ssl: {
        rejectUnauthorized: false // Importante para TiDB Cloud
    }
});

const promisePool = pool.promise();

// Configuração do Multer para upload de imagens
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = './uploads';
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir);
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Apenas imagens JPEG, JPG, PNG, GIF ou WEBP são permitidas!'));
        }
    }
});

// Middleware de autenticação
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Token não fornecido' });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'nosso_clube_secret_key', (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Token inválido' });
        }
        req.user = user;
        next();
    });
};

// ============================================
// ROTAS PÚBLICAS
// ============================================

// Rota raiz para teste
app.get('/', (req, res) => {
    res.json({ 
        message: 'API do Nosso Clube está funcionando!',
        endpoints: {
            test: '/api/test',
            categorias: '/api/categorias',
            itens: '/api/itens',
            login: '/api/login',
            pedidos: '/api/pedidos'
        }
    });
});

// Rota de teste
app.get('/api/test', (req, res) => {
    res.json({ message: 'Servidor está funcionando!' });
});

// Rota de login
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        const [rows] = await promisePool.query(
            'SELECT * FROM usuarios WHERE username = ?',
            [username]
        );
        
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Usuário ou senha inválidos' });
        }
        
        const user = rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        
        if (!validPassword) {
            return res.status(401).json({ error: 'Usuário ou senha inválidos' });
        }
        
        const token = jwt.sign(
            { id: user.id, username: user.username },
            process.env.JWT_SECRET || 'nosso_clube_secret_key',
            { expiresIn: '24h' }
        );
        
        res.json({ token, username: user.username });
    } catch (error) {
        console.error('Erro no login:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

// Rotas para Categorias
app.get('/api/categorias', async (req, res) => {
    try {
        const [rows] = await promisePool.query('SELECT * FROM categorias ORDER BY id');
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar categorias:', error);
        res.status(500).json({ error: 'Erro ao buscar categorias' });
    }
});

// ============================================
// ROTAS DE ITENS DO CARDÁPIO
// ============================================

// GET - Buscar itens
app.get('/api/itens', async (req, res) => {
    try {
        const { categoria } = req.query;
        let query = `
            SELECT i.*, c.nome as categoria_nome 
            FROM itens_cardapio i
            JOIN categorias c ON i.categoria_id = c.id
        `;
        const params = [];
        
        if (categoria && categoria !== 'all' && categoria !== 'specials') {
            query += ' WHERE c.nome = ?';
            params.push(categoria);
        } else if (categoria === 'specials') {
            query += ' WHERE i.is_special = TRUE';
        }
        
        query += ' ORDER BY i.created_at DESC';
        
        const [rows] = await promisePool.query(query, params);
        
        const itens = rows.map(item => {
            // CORREÇÃO: Não prefixar URLs que já são completas
            let imageUrl = null;
            if (item.imagem_path) {
                if (item.imagem_path.startsWith('http')) {
                    imageUrl = item.imagem_path; // URL externa (Pexels, Unsplash)
                } else {
                    imageUrl = `https://nosso-clube-api.onrender.com${item.imagem_path}`; // Upload local
                }
            }
            
            return {
                id: item.id,
                name: item.nome,
                category: item.categoria_nome,
                price: parseFloat(item.preco),
                description: item.descricao,
                image: imageUrl,
                isSpecial: item.is_special === 1,
                specialPrice: item.preco_promocional ? parseFloat(item.preco_promocional) : null
            };
        });
        
        res.json(itens);
    } catch (error) {
        console.error('Erro ao buscar itens:', error);
        res.status(500).json({ error: 'Erro ao buscar itens' });
    }
});

// POST - Criar item (com upload)
app.post('/api/itens', authenticateToken, upload.single('imagem'), async (req, res) => {
    try {
        console.log('📦 Dados recebidos:', req.body);
        
        const { nome, categoria_id, preco, descricao, is_special, preco_promocional } = req.body;
        
        if (!nome || !categoria_id || !preco) {
            return res.status(400).json({ error: 'Campos obrigatórios faltando' });
        }
        
        const imagem_path = req.file ? `/uploads/${req.file.filename}` : null;
        
        const [result] = await promisePool.query(
            `INSERT INTO itens_cardapio 
            (nome, categoria_id, preco, descricao, imagem_path, is_special, preco_promocional) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                nome, 
                parseInt(categoria_id), 
                parseFloat(preco), 
                descricao || '', 
                imagem_path, 
                is_special === 'true' || is_special === true, 
                preco_promocional ? parseFloat(preco_promocional) : null
            ]
        );
        
        res.status(201).json({ 
            id: result.insertId, 
            message: 'Item criado com sucesso'
        });
        
    } catch (error) {
        console.error('❌ Erro ao criar item:', error);
        res.status(500).json({ error: error.message });
    }
});

// PUT - Atualizar item (ACEITA ARQUIVO OU URL) - ÚNICA ROTA PUT
app.put('/api/itens/:id', authenticateToken, upload.single('imagem'), async (req, res) => {
    try {
        const { id } = req.params;
        const { nome, categoria_id, preco, descricao, is_special, preco_promocional, imagem } = req.body;
        
        console.log('\n🔧 ATUALIZANDO ITEM ID:', id);
        console.log('📦 Dados recebidos:', req.body);
        console.log('📸 Arquivo:', req.file);
        
        if (!nome || !categoria_id || !preco) {
            return res.status(400).json({ error: 'Campos obrigatórios faltando' });
        }
        
        let query = 'UPDATE itens_cardapio SET ';
        const params = [];
        const updates = [];
        
        updates.push('nome = ?');
        params.push(nome);
        
        updates.push('categoria_id = ?');
        params.push(parseInt(categoria_id));
        
        updates.push('preco = ?');
        params.push(parseFloat(preco));
        
        updates.push('descricao = ?');
        params.push(descricao || '');
        
        updates.push('is_special = ?');
        params.push(is_special === 'true' || is_special === true);
        
        if (preco_promocional) {
            updates.push('preco_promocional = ?');
            params.push(parseFloat(preco_promocional));
        } else {
            updates.push('preco_promocional = NULL');
        }
        
        // PRIORIDADE 1: Se tiver upload de arquivo, usa ele
        if (req.file) {
            updates.push('imagem_path = ?');
            params.push(`/uploads/${req.file.filename}`);
            console.log('📸 Usando arquivo enviado:', req.file.filename);
        }
        // PRIORIDADE 2: Se tiver URL no campo imagem, usa ela
        else if (imagem && imagem.trim() !== '') {
            updates.push('imagem_path = ?');
            params.push(imagem);
            console.log('🔗 Usando URL fornecida:', imagem);
        }
        
        query += updates.join(', ');
        query += ' WHERE id = ?';
        params.push(parseInt(id));
        
        console.log('📝 Query:', query);
        
        const [result] = await promisePool.query(query, params);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Item não encontrado' });
        }
        
        res.json({ message: 'Item atualizado com sucesso', id: parseInt(id) });
        
    } catch (error) {
        console.error('❌ Erro:', error);
        res.status(500).json({ error: error.message });
    }
});

// DELETE - Deletar item
app.delete('/api/itens/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        
        console.log(`\n🗑️ DELETANDO ITEM ID: ${id}`);
        
        // Buscar a imagem para deletar do servidor (se for upload)
        const [item] = await promisePool.query(
            'SELECT imagem_path FROM itens_cardapio WHERE id = ?',
            [id]
        );
        
        // Deletar o item do banco
        const [result] = await promisePool.query(
            'DELETE FROM itens_cardapio WHERE id = ?',
            [id]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Item não encontrado' });
        }
        
        // Se tiver imagem no servidor (upload), deletar o arquivo
        if (item[0]?.imagem_path && item[0].imagem_path.startsWith('/uploads')) {
            const filePath = path.join(__dirname, item[0].imagem_path);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log('📸 Imagem deletada do servidor');
            }
        }
        
        console.log('✅ Item deletado com sucesso!');
        res.json({ message: 'Item deletado com sucesso' });
        
    } catch (error) {
        console.error('❌ Erro ao deletar item:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// ROTAS DE PEDIDOS
// ============================================

// POST - Criar pedido
app.post('/api/pedidos', async (req, res) => {
    try {
        const { cliente_nome, cliente_telefone, items, forma_pagamento, observacao } = req.body;
        
        const numero_pedido = 'NC' + Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
        
        const total = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        
        const connection = await promisePool.getConnection();
        await connection.beginTransaction();
        
        try {
            // Adicionar forma_pagamento e observacao na tabela pedidos
            const [pedidoResult] = await connection.query(
                'INSERT INTO pedidos (numero_pedido, cliente_nome, cliente_telefone, total, forma_pagamento, observacao) VALUES (?, ?, ?, ?, ?, ?)',
                [numero_pedido, cliente_nome, cliente_telefone, total, forma_pagamento || null, observacao || null]
            );
            
            const pedido_id = pedidoResult.insertId;
            
            for (const item of items) {
                await connection.query(
                    `INSERT INTO pedido_itens 
                    (pedido_id, item_id, quantidade, preco_unitario, preco_promocional, subtotal) 
                    VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        pedido_id, 
                        item.id, 
                        item.quantity, 
                        item.price,
                        item.originalPrice ? true : false,
                        item.price * item.quantity
                    ]
                );
            }
            
            await connection.commit();
            
            res.status(201).json({ 
                message: 'Pedido criado com sucesso',
                numero_pedido: numero_pedido,
                total: total
            });
            
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
        
    } catch (error) {
        console.error('Erro ao criar pedido:', error);
        res.status(500).json({ error: 'Erro ao criar pedido' });
    }
});
app.post('/api/pedidos', async (req, res) => {
    try {
        // ADICIONE ESTES LOGS
        console.log('📦 Dados COMPLETOS recebidos no pedido:', req.body);
        
        const { cliente_nome, cliente_telefone, items, forma_pagamento, observacao } = req.body;
        
        console.log('💰 Forma de pagamento recebida:', forma_pagamento);
        console.log('📝 Observação recebida:', observacao);
        
        // ... resto do código existente
    }
});


// GET - Listar pedidos
app.get('/api/pedidos', authenticateToken, async (req, res) => {
    try {
        console.log('📦 Buscando pedidos...');
        
        const [pedidos] = await promisePool.query(`
            SELECT p.*, 
                   GROUP_CONCAT(
                       JSON_OBJECT(
                           'item_id', pi.item_id,
                           'quantidade', pi.quantidade,
                           'preco', pi.preco_unitario,
                           'promocional', pi.preco_promocional,
                           'subtotal', pi.subtotal
                       )
                   ) as itens_json
            FROM pedidos p
            LEFT JOIN pedido_itens pi ON p.id = pi.pedido_id
            GROUP BY p.id
            ORDER BY p.created_at DESC
        `);
        
        console.log(`📊 Encontrados ${pedidos.length} pedidos`);
        
        const pedidosFormatados = pedidos.map(pedido => ({
            id: pedido.id,
            numero_pedido: pedido.numero_pedido,
            cliente_nome: pedido.cliente_nome,
            cliente_telefone: pedido.cliente_telefone,
            total: pedido.total,
            status: pedido.status,
            created_at: pedido.created_at,
            itens: pedido.itens_json ? JSON.parse('[' + pedido.itens_json + ']') : []
        }));
        
        res.json(pedidosFormatados);
        
    } catch (error) {
        console.error('❌ Erro ao buscar pedidos:', error);
        res.status(500).json({ error: 'Erro ao buscar pedidos' });
    }
});

// PUT - Atualizar status do pedido
app.put('/api/pedidos/:id/status', authenticateToken, async (req, res) => {
    try {
        const { status } = req.body;
        const { id } = req.params;
        
        const statusValidos = ['pending', 'confirmed', 'preparing', 'delivered', 'cancelled'];
        if (!statusValidos.includes(status)) {
            return res.status(400).json({ error: 'Status inválido' });
        }
        
        const [result] = await promisePool.query(
            'UPDATE pedidos SET status = ? WHERE id = ?',
            [status, id]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Pedido não encontrado' });
        }
        
        res.json({ message: 'Status atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar status:', error);
        res.status(500).json({ error: 'Erro ao atualizar status' });
    }
});

// DELETE - Deletar pedido
app.delete('/api/pedidos/:id', authenticateToken, async (req, res) => {
    try {
        const [result] = await promisePool.query(
            'DELETE FROM pedidos WHERE id = ?',
            [req.params.id]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Pedido não encontrado' });
        }
        
        res.json({ message: 'Pedido deletado com sucesso' });
    } catch (error) {
        console.error('Erro ao deletar pedido:', error);
        res.status(500).json({ error: 'Erro ao deletar pedido' });
    }
});

// ============================================
// INICIALIZAÇÃO DO BANCO DE DADOS
// ============================================

async function initDatabase() {
    try {
        console.log('\n📡 TESTANDO CONEXÃO COM O BANCO...');
        
        const [testResult] = await promisePool.query('SELECT 1+1 as resultado');
        console.log('✅ Conexão básica OK! Resultado:', testResult[0].resultado);
        
        const [dbCheck] = await promisePool.query('SELECT DATABASE() as db');
        console.log('📊 Banco atual:', dbCheck[0].db);
        
        const [tables] = await promisePool.query('SHOW TABLES');
        console.log('📋 Tabelas encontradas:', tables.map(t => Object.values(t)[0]).join(', ') || 'Nenhuma');
        
        // Verificar se a tabela usuarios existe
        const [userTableCheck] = await promisePool.query("SHOW TABLES LIKE 'usuarios'");
        
        if (userTableCheck.length === 0) {
            console.log('⚠️ Tabela usuarios não encontrada. Criando...');
            
            await promisePool.query(`
                CREATE TABLE IF NOT EXISTS usuarios (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    username VARCHAR(50) UNIQUE NOT NULL,
                    password_hash VARCHAR(255) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            const hash = await bcrypt.hash('admin123', 10);
            
            await promisePool.query(
                'INSERT INTO usuarios (username, password_hash) VALUES (?, ?)',
                ['admin', hash]
            );
            
            console.log('✅ Usuário admin criado com sucesso!');
        } else {
            console.log('✅ Tabela usuarios encontrada');
            
            const [adminCheck] = await promisePool.query('SELECT * FROM usuarios WHERE username = "admin"');
            
            if (adminCheck.length === 0) {
                console.log('⚠️ Usuário admin não encontrado. Criando...');
                const hash = await bcrypt.hash('admin123', 10);
                await promisePool.query(
                    'INSERT INTO usuarios (username, password_hash) VALUES (?, ?)',
                    ['admin', hash]
                );
                console.log('✅ Usuário admin criado');
            }
        }
        
        // Verificar categorias
        const [catCheck] = await promisePool.query("SHOW TABLES LIKE 'categorias'");
        
        if (catCheck.length === 0) {
            console.log('⚠️ Tabela categorias não encontrada. Criando...');
            
            await promisePool.query(`
                CREATE TABLE IF NOT EXISTS categorias (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    nome VARCHAR(50) UNIQUE NOT NULL,
                    descricao TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            await promisePool.query(`
                INSERT INTO categorias (nome, descricao) VALUES
                ('comidas', 'Pratos principais e refeições'),
                ('bebidas', 'Bebidas em geral'),
                ('sobremesas', 'Doces e sobremesas')
            `);
            
            console.log('✅ Categorias criadas');
        }
        
        console.log('🎉 BANCO DE DADOS INICIALIZADO COM SUCESSO!\n');
        
    } catch (error) {
        console.error('\n❌❌❌ ERRO NA INICIALIZAÇÃO DO BANCO:');
        console.error('Mensagem:', error.message);
        console.error('Código:', error.code);
        console.error('Errno:', error.errno);
        console.error('SQL State:', error.sqlState);
        console.error('SQL:', error.sql);
        console.error('Stack:', error.stack);
        console.error('❌❌❌ FIM DO ERRO\n');
        
        console.log('⚠️ O servidor continuará rodando, mas o banco pode não estar acessível.');
    }
}

// ============================================
// ROTA TEMPORÁRIA PARA GERAR HASH (remova depois)
// ============================================
app.get('/api/create-hash', async (req, res) => {
    try {
        const hash = await bcrypt.hash('admin123', 10);
        res.json({ 
            senha: 'admin123',
            hash: hash,
            comando_sql: `UPDATE usuarios SET password_hash = '${hash}' WHERE username = 'admin';`
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n🚀 Servidor do Nosso Clube rodando na porta ${PORT}`);
    console.log(`📱 Acesse: http://localhost:${PORT}`);
    console.log(`🔍 Teste: http://localhost:${PORT}/api/test\n`);
    
    await initDatabase();
});