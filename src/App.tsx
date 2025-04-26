import { BrowserRouter, Routes, Route } from "react-router-dom";
import Room from './pages/Room';
import Main from './pages/Main';
import NotFound404 from './pages/NotFound404';

/**
 * Главный компонент приложения с настройкой маршрутизации
 */
const App: React.FC = () => {
  return (
    <BrowserRouter>
      <Routes>
        {/* Маршрут для комнаты видеоконференции */}
        <Route path="/room/:id" element={<Room />} />
        
        {/* Главная страница со списком комнат */}
        <Route path="/" element={<Main />} />
        
        {/* Страница 404 для несуществующих маршрутов */}
        <Route path="*" element={<NotFound404 />} />
      </Routes>
    </BrowserRouter>
  );
};

export default App;