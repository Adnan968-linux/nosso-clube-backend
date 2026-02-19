
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3005;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// Configuração do MySQL - ALTERE A SENHA AQUI!
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'root', // COLOQUE SUA SENHA DO MYSQL AQUI
    database: 'nosso_clube_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
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
    limits: { fileSize: 50 * 1024 * 1024 }, // AUMENTADO para 50MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/; // Adicionei webp
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

// Rotas para Itens do Cardápio
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
        
        const itens = rows.map(item => ({
            id: item.id,
            name: item.nome,
            category: item.categoria_nome,
            price: item.preco,
            description: item.descricao,
            image: item.imagem_path ? `http://localhost:${PORT}${item.imagem_path}` : null,
            isSpecial: item.is_special === 1,
            specialPrice: item.preco_promocional
        }));
        
        res.json(itens);
    } catch (error) {
        console.error('Erro ao buscar itens:', error);
        res.status(500).json({ error: 'Erro ao buscar itens' });
    }
});

app.post('/api/itens', authenticateToken, upload.single('imagem'), async (req, res) => {
    try {
        console.log('\n=== NOVO ITEM RECEBIDO ===');
        console.log('1️⃣ Corpo da requisição (req.body):', req.body);
        console.log('2️⃣ Arquivo (req.file):', req.file);
        console.log('3️⃣ Headers:', req.headers);
        
        const { nome, categoria_id, preco, descricao, is_special, preco_promocional } = req.body;
        
        // VALIDAÇÕES DETALHADAS
        if (!nome) throw new Error('❌ Campo "nome" é obrigatório');
        if (!categoria_id) throw new Error('❌ Campo "categoria_id" é obrigatório');
        if (!preco) throw new Error('❌ Campo "preco" é obrigatório');
        
        // Converter preço (trocando vírgula por ponto se necessário)
        let precoNumerico = preco.toString().replace(',', '.');
        precoNumerico = parseFloat(precoNumerico);
        
        if (isNaN(precoNumerico) || precoNumerico <= 0) {
            throw new Error(`❌ Preço inválido: ${preco} (convertido para ${precoNumerico})`);
        }
        
        // Converter categoria_id para número
        const categoriaIdNumerico = parseInt(categoria_id);
        if (isNaN(categoriaIdNumerico)) {
            throw new Error(`❌ categoria_id inválido: ${categoria_id}`);
        }
        
        console.log('4️⃣ Dados processados:', {
            nome,
            categoria_id: categoriaIdNumerico,
            preco: precoNumerico,
            descricao: descricao || '',
            is_special: is_special === 'true' || is_special === true,
            preco_promocional: preco_promocional
        });
        
        const imagem_path = req.file ? `/uploads/${req.file.filename}` : null;
        
        console.log('5️⃣ Tentando inserir no banco...');
        
        const [result] = await promisePool.query(
            `INSERT INTO itens_cardapio 
            (nome, categoria_id, preco, descricao, imagem_path, is_special, preco_promocional) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                nome, 
                categoriaIdNumerico, 
                precoNumerico, 
                descricao || '', 
                imagem_path, 
                is_special === 'true' || is_special === true, 
                preco_promocional ? parseFloat(preco_promocional.toString().replace(',', '.')) : null
            ]
        );
        
        console.log('6️⃣ ✅ SUCESSO! ID inserido:', result.insertId);
        
        res.status(201).json({ 
            id: result.insertId, 
            message: 'Item criado com sucesso'
        });
        
    } catch (error) {
        console.error('\n❌❌❌ ERRO DETALHADO ❌❌❌');
        console.error('Mensagem:', error.message);
        console.error('Stack completo:', error.stack);
        console.error('❌❌❌ FIM DO ERRO ❌❌❌\n');
        
        res.status(500).json({ 
            error: error.message,
            details: error.toString()
        });
    }
});

app.post('/api/itens', authenticateToken, upload.single('imagem'), async (req, res) => {
    try {
        const { nome, categoria_id, preco, descricao, is_special, preco_promocional } = req.body;
        const imagem_path = req.file ? `/uploads/${req.file.filename}` : null;
        
        const [result] = await promisePool.query(
            `INSERT INTO itens_cardapio 
            (nome, categoria_id, preco, descricao, imagem_path, is_special, preco_promocional) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [nome, categoria_id, preco, descricao, imagem_path, is_special || false, preco_promocional || null]
        );
        
        res.status(201).json({ 
            id: result.insertId, 
            message: 'Item criado com sucesso',
            imagem_path: imagem_path ? `http://localhost:${PORT}${imagem_path}` : null
        });
    } catch (error) {
        console.error('Erro ao criar item:', error);
        res.status(500).json({ error: 'Erro ao criar item' });
    }
});

app.put('/api/itens/:id', authenticateToken, upload.single('imagem'), async (req, res) => {
    try {
        const { nome, categoria_id, preco, descricao, is_special, preco_promocional } = req.body;
        
        let query = 'UPDATE itens_cardapio SET nome = ?, categoria_id = ?, preco = ?, descricao = ?, is_special = ?, preco_promocional = ?';
        const params = [nome, categoria_id, preco, descricao, is_special || false, preco_promocional || null];
        
        if (req.file) {
            const [oldItem] = await promisePool.query('SELECT imagem_path FROM itens_cardapio WHERE id = ?', [req.params.id]);
            if (oldItem[0]?.imagem_path) {
                const oldPath = path.join(__dirname, oldItem[0].imagem_path);
                if (fs.existsSync(oldPath)) {
                    fs.unlinkSync(oldPath);
                }
            }
            
            query += ', imagem_path = ?';
            params.push(`/uploads/${req.file.filename}`);
        }
        
        query += ' WHERE id = ?';
        params.push(req.params.id);
        
        await promisePool.query(query, params);
        
        res.json({ message: 'Item atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar item:', error);
        res.status(500).json({ error: 'Erro ao atualizar item' });
    }
});

app.delete('/api/itens/:id', authenticateToken, async (req, res) => {
    try {
        const [item] = await promisePool.query('SELECT imagem_path FROM itens_cardapio WHERE id = ?', [req.params.id]);
        
        if (item[0]?.imagem_path) {
            const imagePath = path.join(__dirname, item[0].imagem_path);
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
            }
        }
        
        await promisePool.query('DELETE FROM itens_cardapio WHERE id = ?', [req.params.id]);
        
        res.json({ message: 'Item deletado com sucesso' });
    } catch (error) {
        console.error('Erro ao deletar item:', error);
        res.status(500).json({ error: 'Erro ao deletar item' });
    }
});

// Rotas para Pedidos
app.post('/api/pedidos', async (req, res) => {
    try {
        const { cliente_nome, cliente_telefone, items } = req.body;
        
        const numero_pedido = 'NC' + Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
        
        const total = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        
        const connection = await promisePool.getConnection();
        await connection.beginTransaction();
        
        try {
            const [pedidoResult] = await connection.query(
                'INSERT INTO pedidos (numero_pedido, cliente_nome, cliente_telefone, total) VALUES (?, ?, ?, ?)',
                [numero_pedido, cliente_nome, cliente_telefone, total]
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

app.get('/api/pedidos', authenticateToken, async (req, res) => {
    try {
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
        
        const pedidosFormatados = pedidos.map(pedido => ({
            ...pedido,
            itens: pedido.itens_json ? JSON.parse('[' + pedido.itens_json + ']') : []
        }));
        
        res.json(pedidosFormatados);
    } catch (error) {
        console.error('Erro ao buscar pedidos:', error);
        res.status(500).json({ error: 'Erro ao buscar pedidos' });
    }
});

// Inicializar banco de dados com usuário admin
async function initDatabase() {
    try {
        const [rows] = await promisePool.query('SELECT * FROM usuarios WHERE username = "admin"');
        
        if (rows.length === 0) {
            const hash = await bcrypt.hash('admin123', 10);
            
            await promisePool.query(
                'INSERT INTO usuarios (username, password_hash) VALUES (?, ?)',
                ['admin', hash]
            );
            
            console.log('Usuário admin criado com senha: admin123');
        }
    } catch (error) {
        console.error('Erro ao inicializar banco de dados:', error);
    }
}

app.listen(PORT, async () => {
    console.log(`🚀 Servidor do Nosso Clube rodando na porta ${PORT}`);
    await initDatabase();
});
// Rota para atualizar status do pedido
app.put('/api/pedidos/:id/status', authenticateToken, async (req, res) => {
    try {
        const { status } = req.body;
        const { id } = req.params;
        
        // Validar status
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

// Rota para buscar pedido por número
app.get('/api/pedidos', authenticateToken, async (req, res) => {
    try {
        const { numero } = req.query;
        let query = `
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
        `;
        
        if (numero) {
            query += ' WHERE p.numero_pedido = ?';
        }
        
        query += ' GROUP BY p.id ORDER BY p.created_at DESC';
        
        const [pedidos] = await promisePool.query(query, numero ? [numero] : []);
        
        const pedidosFormatados = pedidos.map(pedido => ({
            ...pedido,
            itens: pedido.itens_json ? JSON.parse('[' + pedido.itens_json + ']') : []
        }));
        
        res.json(pedidosFormatados);
    } catch (error) {
        console.error('Erro ao buscar pedidos:', error);
        res.status(500).json({ error: 'Erro ao buscar pedidos' });
    }
});

// Rota para deletar um pedido específico
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